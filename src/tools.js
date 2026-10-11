import { z } from 'zod';

import {
  TYPE_TASK,
  TYPE_NOTE,
  TYPE_STICKY,
  resolveBoardFilters,
  renderList,
  renderItem,
  mergeAllLists,
  renderAll,
} from './listing.js';
import { isBlankValue, applyDueDateFallback } from './sanitize.js';
import {
  buildRecommendationBody,
  renderRecommendation,
  describeLockError,
} from './recommend.js';
import {
  lockProjectId,
  sanitizeFilters,
  assertProjectAllowed,
  stripHallucinatedListFilters,
  matchesAssignee,
  hasOwnerInfo,
} from './projectLock.js';
import { markdownToDescription } from './converters.js';

export function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

export function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

const ANNOTATIONS = {
  READ_ONLY: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  WRITE: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  IDEMPOTENT_WRITE: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  DESTRUCTIVE: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

export function registerStandaloneTools(server, { api, projectLock = null, wrapHandler = (name, fn) => fn }) {
  const PROJECT_LOCK = projectLock;

  // --- Standalone CRUD tools (Part B) ---
  // These operate directly via the user-scoped API key and do NOT require any
  // folder to be configured with planko_setup. Notes are Task docs with type=2,
  // sticky notes type=3, tasks type=1. Edit/Delete/View work on any of them;
  // Complete is task-oriented but accepts any id.

  const editableType = z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Change type: 1=task, 2=note, 3=sticky note');

  const objectId = z
    .string()
    .regex(/^[a-fA-F\d]{24}$/, 'Must be a 24-character hex ObjectId');

  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;

  // Shared editable task/note properties (all optional). `description` is Markdown
  // here and is converted to BlockNote JSON before being sent to the backend.
  const taskProps = {
    description: z
      .string()
      .optional()
      .describe('Body as Markdown (converted to BlockNote JSON before saving)'),
    dueDate: z.string().optional().describe('Due date (ISO 8601 string)'),
    datePlain: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
      .optional()
      .describe('Plain date, YYYY-MM-DD'),
    time: z.string().regex(timeRegex, 'Must be HH:MM').optional().describe('Start time, HH:MM'),
    endTime: z.string().regex(timeRegex, 'Must be HH:MM').optional().describe('End time, HH:MM'),
    alert: z.boolean().optional().describe('Whether an alert/reminder is enabled'),
    alertLeadTime: z
      .enum(['ontime', '15min', '30min', '1hour', '1day'])
      .nullable()
      .optional()
      .describe('Reminder lead time (null or one of ontime/15min/30min/1hour/1day)'),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe('Priority: 1, 2, or 3'),
    repeat: z
      .enum(['daily', 'workdays', 'weekly', 'biweekly', 'monthly', 'custom_weekly', 'yearly'])
      .nullable()
      .optional()
      .describe('Recurrence rule (null or one of the recurrence keywords)'),
    // The backend stores an integer here (Joi.number().integer()), NOT a date:
    // the weekday (1-7) for weekly repeats or the day of month (1-31) for monthly.
    repeatDate: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Recurrence day (integer, not a date): weekday 1-7 for weekly, day of month 1-31 for monthly'),
    selectedWeekdays: z
      .array(z.number().int().min(0).max(6))
      .optional()
      .describe('Weekdays for custom_weekly repeat (0=Sunday..6=Saturday)'),
    parentId: objectId.optional().describe('Parent task id (for subtasks)'),
    tags: z.array(objectId).optional().describe('Array of tag ids'),
    kanbanColumnId: objectId.optional().describe('Kanban column id'),
    boardId: objectId.optional().describe('Board id'),
  };

  /**
   * Build a request body from tool params: drop undefined values and convert the
   * Markdown `description` into BlockNote JSON.
   */
  function buildTaskBody(params) {
    const body = {};
    for (const [key, value] of Object.entries(params)) {
      if (isBlankValue(value)) continue;
      body[key] = value;
    }
    applyDueDateFallback(body);
    if ('description' in body) {
      body.description = markdownToDescription(body.description);
    }
    return body;
  }

  /**
   * Resolve a project name to a project id via the user's accessible projects
   * (NOT the local folder config), so create tools work without any setup.
   */
  async function resolveProjectId(projectName) {
    const { projects } = await api.projects();
    const match = projects.find(
      (p) => p.name.toLowerCase() === projectName.toLowerCase()
    );
    if (!match) {
      const available = projects.map((p) => `  - ${p.name}`).join('\n');
      throw new Error(
        `Project "${projectName}" not found.\n\nAvailable projects:\n${available}`
      );
    }
    return match._id;
  }

  /** Extract { id, name } from a create/edit response (shape-tolerant). */
  function describeTask(res) {
    const t = (res && (res.task || res.data)) || res || {};
    return {
      id: t._id || t.id || 'unknown',
      name: t.name != null ? t.name : 'unknown',
    };
  }

  /**
   * When PROJECT_LOCK is set, fetch a by-id task and refuse the operation unless
   * it belongs to the locked project. No-op when the lock is null.
   */
  async function assertTaskInLock(taskId) {
    if (!PROJECT_LOCK) return;
    const res = await api.getTask(taskId);
    assertProjectAllowed(PROJECT_LOCK, unwrapItem(res));
  }

  /**
   * Shared create handler for tasks (type=1) and notes (type=2).
   */
  async function handleCreate(type, params, kindLabel) {
    const { name, projectName, ...rest } = params;
    const body = buildTaskBody(rest);
    body.name = name;
    body.type = type;

    if (PROJECT_LOCK) {
      // Hard override: always the locked project; ignore any caller project field
      // and do NOT resolve projectName.
      body.projectId = lockProjectId(PROJECT_LOCK, body.projectId);
    } else if (!isBlankValue(projectName)) {
      // Resolve projectName -> projectId via the API. When omitted, OMIT the key
      // entirely so the backend applies the user's default project.
      body.projectId = await resolveProjectId(projectName);
    }

    const res = await api.createTask(body);
    const { id, name: savedName } = describeTask(res);
    const where = body.projectId
      ? ` in project ${body.projectId}`
      : ' in your default project';
    return toolOk(`Created ${kindLabel} "${savedName}" (id: ${id})${where}.`);
  }

  /**
   * Shared edit handler for tasks and notes (same endpoint).
   */
  async function handleEdit(params, kindLabel) {
    const { taskId, ...rest } = params;
    const body = buildTaskBody(rest);
    const changed = Object.keys(body);
    if (changed.length === 0) {
      return toolError('Nothing to update: provide at least one field to change.');
    }
    if (PROJECT_LOCK) {
      // Refuse to touch a task outside the locked project.
      await assertTaskInLock(taskId);
      // If the caller tried to move the task to another project, force it back to
      // the lock (never let an edit move a task OUT of the locked project). If no
      // project field was passed, leave the project unchanged.
      if ('projectId' in body) {
        body.projectId = lockProjectId(PROJECT_LOCK, body.projectId);
      }
    }
    const res = await api.updateTask(taskId, body);
    const { id, name: savedName } = describeTask(res);
    return toolOk(
      `Updated ${kindLabel} "${savedName}" (id: ${id}). Changed: ${changed.join(', ')}.`
    );
  }

  // ---- planko_create_task ----
  server.registerTool(
    'planko_create_task',
    {
      title: 'Create task',
      description: 'Create a Planko task (type=1) directly, immediately and without approval. Works without any folder setup. Provide a name (required); all other properties are optional. Optionally target a project by name (otherwise your default project is used). To propose a task for the account owner to accept or reject instead, use planko_recommend_task.',
      inputSchema: {
        name: z.string().describe('Task name (required)'),
        projectName: z
          .string()
          .optional()
          .describe('Project name to create the task in (optional — omit for your default project)'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.WRITE,
    },
    wrapHandler('planko_create_task', async (params) => {
      try {
        return await handleCreate(TYPE_TASK, params, 'task');
      } catch (err) {
        return toolError(`Create task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_create_note ----
  server.registerTool(
    'planko_create_note',
    {
      title: 'Create note',
      description: 'Create a Planko note (type=2) directly. Works without any folder setup. Provide a name (required); all other properties are optional. Optionally target a project by name (otherwise your default project is used).',
      inputSchema: {
        name: z.string().describe('Note name (required)'),
        projectName: z
          .string()
          .optional()
          .describe('Project name to create the note in (optional — omit for your default project)'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.WRITE,
    },
    wrapHandler('planko_create_note', async (params) => {
      try {
        return await handleCreate(TYPE_NOTE, params, 'note');
      } catch (err) {
        return toolError(`Create note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_create_sticky_note ----
  server.registerTool(
    'planko_create_sticky_note',
    {
      title: 'Create sticky note',
      description: 'Create a Planko sticky note (type=3) directly. A sticky note is a task-page item with every task property (dates, priority, tags, kanban column). Provide a name (required); all other properties are optional. Optionally target a project by name (otherwise your default project is used).',
      inputSchema: {
        name: z.string().describe('Sticky note name (required)'),
        projectName: z
          .string()
          .optional()
          .describe('Project name to create the sticky note in (optional — omit for your default project)'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.WRITE,
    },
    wrapHandler('planko_create_sticky_note', async (params) => {
      try {
        return await handleCreate(TYPE_STICKY, params, 'sticky note');
      } catch (err) {
        return toolError(`Create sticky note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_recommend_task ----
  // PL274: a SUGGESTION, not a write. The backend stores it as a pending
  // recommendation addressed to the API key's owner and notifies them; the task is
  // created only if they accept it in Planko. There is no read-back endpoint.
  server.registerTool(
    'planko_recommend_task',
    {
      title: 'Recommend task',
      description: 'Suggest a new task to the Planko account owner instead of creating it. The owner gets a notification (notification centre + push) with Accept/Reject buttons; the task is created only when they accept. Use this when a human should approve before anything is written, or when you must not create tasks directly; use planko_create_task to create immediately. The recipient is always the owner of the API key (never other project members). Provide a title (required); all other task properties are optional and are applied to the task on accept. The outcome cannot be read back afterwards and re-sending creates a duplicate suggestion, so send each suggestion once.',
      inputSchema: {
        title: z.string().trim().min(1).max(500).describe('Suggested task name (required, up to 500 characters)'),
        projectName: z
          .string()
          .optional()
          .describe('Project name the task would be created in (optional — omit for the owner\'s default project)'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.WRITE,
    },
    wrapHandler('planko_recommend_task', async (params) => {
      try {
        const { title, projectName, ...rest } = params;
        const body = buildTaskBody(rest);
        let projectNameIgnored = false;

        if (PROJECT_LOCK) {
          // Same hard override as handleCreate: the suggestion can only target
          // the locked project; projectName is neither resolved nor honoured.
          body.projectId = lockProjectId(PROJECT_LOCK, body.projectId);
          projectNameIgnored = !isBlankValue(projectName);
        } else if (!isBlankValue(projectName)) {
          body.projectId = await resolveProjectId(projectName);
        }

        let res;
        try {
          res = await api.createRecommendation(buildRecommendationBody(title, body));
        } catch (err) {
          throw describeLockError(err, PROJECT_LOCK);
        }
        return toolOk(
          renderRecommendation(res, {
            projectId: body.projectId,
            lock: PROJECT_LOCK,
            projectNameIgnored,
          })
        );
      } catch (err) {
        return toolError(`Recommend task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_edit_task ----
  server.registerTool(
    'planko_edit_task',
    {
      title: 'Edit task',
      description: 'Edit an existing Planko task by id. Provide the taskId and any properties to change. The Markdown description is converted to BlockNote JSON.',
      inputSchema: {
        taskId: objectId.describe('Id of the task to edit (required)'),
        name: z.string().optional().describe('New task name'),
        type: editableType,
        projectId: objectId.optional().describe('Move to a different project by id'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.IDEMPOTENT_WRITE,
    },
    wrapHandler('planko_edit_task', async (params) => {
      try {
        return await handleEdit(params, 'task');
      } catch (err) {
        return toolError(`Edit task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_edit_note ----
  server.registerTool(
    'planko_edit_note',
    {
      title: 'Edit note',
      description: 'Edit an existing Planko note by id (shares the task edit endpoint). Provide the taskId and any properties to change. The Markdown description is converted to BlockNote JSON.',
      inputSchema: {
        taskId: objectId.describe('Id of the note to edit (required)'),
        name: z.string().optional().describe('New note name'),
        type: editableType,
        projectId: objectId.optional().describe('Move to a different project by id'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.IDEMPOTENT_WRITE,
    },
    wrapHandler('planko_edit_note', async (params) => {
      try {
        return await handleEdit(params, 'note');
      } catch (err) {
        return toolError(`Edit note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_edit_sticky_note ----
  server.registerTool(
    'planko_edit_sticky_note',
    {
      title: 'Edit sticky note',
      description: 'Edit an existing Planko sticky note by id (shares the task edit endpoint). Provide the taskId and any properties to change. The Markdown description is converted to BlockNote JSON.',
      inputSchema: {
        taskId: objectId.describe('Id of the sticky note to edit (required)'),
        name: z.string().optional().describe('New sticky note name'),
        type: editableType,
        projectId: objectId.optional().describe('Move to a different project by id'),
        ...taskProps,
      },
      annotations: ANNOTATIONS.IDEMPOTENT_WRITE,
    },
    wrapHandler('planko_edit_sticky_note', async (params) => {
      try {
        return await handleEdit(params, 'sticky note');
      } catch (err) {
        return toolError(`Edit sticky note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_complete_task ----
  server.registerTool(
    'planko_complete_task',
    {
      title: 'Complete task',
      description: 'Mark a Planko task complete (status=2) by id. Also works on a sticky note id (sticky notes have the same status field).',
      inputSchema: {
        taskId: objectId.describe('Id of the task to complete (required)'),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    wrapHandler('planko_complete_task', async ({ taskId }) => {
      try {
        await assertTaskInLock(taskId);
        const res = await api.completeTask(taskId);
        const { id, name } = describeTask(res);
        return toolOk(`Completed task "${name}" (id: ${id}).`);
      } catch (err) {
        return toolError(`Complete task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_delete_task ----
  server.registerTool(
    'planko_delete_task',
    {
      title: 'Delete task',
      description: 'Delete a Planko task by id.',
      inputSchema: {
        taskId: objectId.describe('Id of the task to delete (required)'),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    wrapHandler('planko_delete_task', async ({ taskId }) => {
      try {
        await assertTaskInLock(taskId);
        await api.deleteTask(taskId);
        return toolOk(`Deleted task (id: ${taskId}).`);
      } catch (err) {
        return toolError(`Delete task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_delete_note ----
  server.registerTool(
    'planko_delete_note',
    {
      title: 'Delete note',
      description: 'Delete a Planko note by id (shares the task delete endpoint).',
      inputSchema: {
        taskId: objectId.describe('Id of the note to delete (required)'),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    wrapHandler('planko_delete_note', async ({ taskId }) => {
      try {
        await assertTaskInLock(taskId);
        await api.deleteTask(taskId);
        return toolOk(`Deleted note (id: ${taskId}).`);
      } catch (err) {
        return toolError(`Delete note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_delete_sticky_note ----
  server.registerTool(
    'planko_delete_sticky_note',
    {
      title: 'Delete sticky note',
      description: 'Delete a Planko sticky note by id (shares the task delete endpoint).',
      inputSchema: {
        taskId: objectId.describe('Id of the sticky note to delete (required)'),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    wrapHandler('planko_delete_sticky_note', async ({ taskId }) => {
      try {
        await assertTaskInLock(taskId);
        await api.deleteTask(taskId);
        return toolOk(`Deleted sticky note (id: ${taskId}).`);
      } catch (err) {
        return toolError(`Delete sticky note failed: ${err.message}`);
      }
    })
  );

  // --- Standalone READ tools (Part C) ---
  // Read-only, user-scoped via API key; no folder setup required. List tools send
  // `type` (1=tasks, 2=notes, 3=sticky notes; omitted = tasks + sticky notes) and
  // parametrized filters; view tools fetch one item by id and render its
  // BlockNote description as Markdown. No mutation.

  const datePlain = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

  const sortBySchema = z
    .string()
    .describe(
      "Sort as 'field:asc' or 'field:desc'. Allowed fields: dueDate, createdAt, updatedAt, priority, position, name. Default updatedAt:desc."
    );

  /**
   * Build the API filter params from tool params, resolving projectName and the
   * kanban board/column names. `type` may be undefined (backend: tasks + sticky).
   */
  async function buildListParams(type, params) {
    // assigneeName / boardName / kanbanColumnName are resolved client-side and
    // must never reach the backend, which rejects unknown query keys.
    const { projectName, assigneeName, boardName, kanbanColumnName, ...rest } = params;
    // Sanitize scalar filters (drops blank/placeholder values, incl. a blank
    // assigneeId => "all members").
    const out = { ...sanitizeFilters(rest) };
    if (type != null) out.type = type;
    if (PROJECT_LOCK) {
      // Drop the id narrowers this class of agent fabricates with non-blank
      // garbage (parentId=projectId, assigneeId from a chat id, guessed priority,
      // a boardId copied from somewhere) that would silently zero the "list the
      // whole team" result. Board/column narrowing under lock is by NAME below.
      stripHallucinatedListFilters(out);
      // Hard override: force the project regardless of caller input. Do NOT
      // resolve projectName here — the override wins unconditionally, so an
      // invalid projectName must not be able to fail an otherwise-locked list.
      out.projectId = lockProjectId(PROJECT_LOCK, out.projectId);
    } else if (!isBlankValue(projectName)) {
      // Unlocked (default) path: unchanged behavior.
      out.projectId = await resolveProjectId(projectName);
    }
    if (!isBlankValue(boardName) || !isBlankValue(kanbanColumnName)) {
      const boards = await api.boards();
      Object.assign(
        out,
        resolveBoardFilters(
          { boardName, kanbanColumnName, boardId: out.boardId, kanbanColumnId: out.kanbanColumnId },
          boards
        )
      );
    }
    return out;
  }

  /** Extract a single item from a view response (shape-tolerant). */
  function unwrapItem(res) {
    return (res && (res.task || res.data)) || res || {};
  }

  // Shared list filter surface (task tools use all; note tools use the applicable subset).
  const listStatus = z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe('Filter by status: 1=open, 2=complete');
  const listShowCompleted = z
    .boolean()
    .optional()
    .describe('When false/omitted (and no explicit status), completed items are excluded');
  const listProjectName = z
    .string()
    .optional()
    .describe('Filter to a project by name (resolved to its id)');
  const listProjectId = objectId.optional().describe('Filter to a project by id');
  const listAssigneeId = objectId
    .optional()
    .describe('Filter to a single project member by their user id (omit for all members)');
  const listTags = z.array(objectId).optional().describe('Filter by tag ids (AND — item must have all)');
  const listSearch = z.string().optional().describe('Case-insensitive search on the name');
  const listSortBy = sortBySchema.optional();
  const listLimit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max items to return (default 50, max 200)');
  const listPage = z.number().int().min(1).optional().describe('Page number (default 1)');
  const listPriority = z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Filter by priority: 1, 2, or 3');
  const listParentId = objectId.optional().describe('List subtasks of this parent task id');
  const listAssigneeName = z
    .string()
    .optional()
    .describe(
      'Narrow to ONE team member by their NAME or email (case-insensitive). ' +
        'Omit to list the WHOLE team (all members). Only set this when the user ' +
        'explicitly names a person; never guess.'
    );
  const listBoardName = z
    .string()
    .optional()
    .describe(
      'Filter by kanban board NAME (case-insensitive, resolved against your own and workspace boards). ' +
        'Only set this when the user explicitly names a board; never guess.'
    );
  const listKanbanColumnName = z
    .string()
    .optional()
    .describe(
      'Filter by kanban column NAME (e.g. "To Do", "Done"). Resolved inside boardName when given; ' +
        'without a board the name must be unique across your boards. Only set this when the user ' +
        'explicitly names a column; never guess.'
    );
  const listBoardId = objectId.optional().describe('Filter by kanban board id');
  const listKanbanColumnId = objectId.optional().describe('Filter by kanban column id');

  // Build the list-filter schema. Under PROJECT_LOCK the project is forced and the
  // caller is a bespoke, project-scoped agent whose model fabricates id/priority
  // narrowers (parentId/assigneeId/priority/boardId/kanbanColumnId) that silently
  // zero the result — so those fields are NOT offered; member and board/column
  // narrowing is by NAME instead. Unlocked (default, e.g. clawis) keeps the full
  // surface. `kind`: 'task' | 'note' | 'sticky' | 'all' — status/due-date filters
  // are offered for every task-page kind (sticky notes carry the same fields).
  function listSchema(kind) {
    const taskLike = kind !== 'note';
    const base = { showCompleted: listShowCompleted };
    if (taskLike) base.status = listStatus;
    const tail = {
      tags: listTags,
      search: listSearch,
      boardName: listBoardName,
      kanbanColumnName: listKanbanColumnName,
      ...(taskLike
        ? {
            dueDateFrom: datePlain.optional().describe('Inclusive lower bound on due date (YYYY-MM-DD)'),
            dueDateTo: datePlain.optional().describe('Inclusive upper bound on due date (YYYY-MM-DD)'),
          }
        : {}),
      sortBy: listSortBy,
      limit: listLimit,
      ...(kind === 'all' ? {} : { page: listPage }),
    };
    if (PROJECT_LOCK) {
      return { ...base, assigneeName: listAssigneeName, ...tail };
    }
    return {
      ...base,
      priority: listPriority,
      projectName: listProjectName,
      projectId: listProjectId,
      assigneeId: listAssigneeId,
      ...(taskLike ? { parentId: listParentId } : {}),
      boardId: listBoardId,
      kanbanColumnId: listKanbanColumnId,
      ...tail,
    };
  }

  const BOARD_SCOPE_NOTE =
    ' Board/column filters match items on your own and workspace boards; with a project scope, teammates’ items on their personal boards are not matched.';

  /**
   * Client-side member narrowing by NAME (used under PROJECT_LOCK, where the
   * agent narrows by a person's name instead of a fabricated user id). Returns
   * { result, note }. When assigneeName is blank, the result is unchanged. When
   * items lack populated owner info (backend owner-populate not deployed yet),
   * the filter can't be applied — the full list is returned with an explanatory
   * note rather than a misleading empty result.
   */
  function applyAssigneeName(result, assigneeName) {
    if (isBlankValue(assigneeName)) return { result, note: null };
    const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
    if (!hasOwnerInfo(tasks)) {
      return {
        result,
        note: `Could not narrow to "${assigneeName}" — owner info is not available yet; showing all members.`,
      };
    }
    const filtered = tasks.filter((t) => matchesAssignee(t.userId, assigneeName));
    return { result: { ...result, tasks: filtered, total: filtered.length }, note: null };
  }

  /** Shared list handler: one backend call for a single type. */
  async function handleList(type, params, kindLabelPlural) {
    const apiParams = await buildListParams(type, params);
    const result = await api.listTasks(apiParams);
    const { result: filtered, note } = applyAssigneeName(result, params.assigneeName);
    const out = renderList(filtered, kindLabelPlural);
    return toolOk(note ? `${out}\n\nNote: ${note}` : out);
  }

  // ---- planko_list_tasks ----
  server.registerTool(
    'planko_list_tasks',
    {
      title: 'List tasks',
      description: 'List Planko tasks (type=1) directly, no folder setup required. All filters are optional; omit any the user did not explicitly ask for. Recurring tasks appear as separate dated occurrences. Returns a concise summary, not raw JSON.' +
        BOARD_SCOPE_NOTE,
      inputSchema: listSchema('task'),
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_list_tasks', async (params) => {
      try {
        return await handleList(TYPE_TASK, params, 'tasks');
      } catch (err) {
        return toolError(`List tasks failed: ${err.message}`);
      }
    })
  );

  // ---- planko_list_notes ----
  server.registerTool(
    'planko_list_notes',
    {
      title: 'List notes',
      description: 'List Planko notes (type=2) directly, no folder setup required. All filters are optional; omit any the user did not explicitly ask for. Deleted and recurring-copy notes are excluded. Returns a concise summary, not raw JSON.' +
        BOARD_SCOPE_NOTE,
      inputSchema: listSchema('note'),
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_list_notes', async (params) => {
      try {
        return await handleList(TYPE_NOTE, params, 'notes');
      } catch (err) {
        return toolError(`List notes failed: ${err.message}`);
      }
    })
  );

  // ---- planko_list_sticky_notes ----
  server.registerTool(
    'planko_list_sticky_notes',
    {
      title: 'List sticky notes',
      description: 'List Planko sticky notes (type=3) directly, no folder setup required. Sticky notes are task-page items, so the same filters as planko_list_tasks apply. All filters are optional; omit any the user did not explicitly ask for. Returns a concise summary, not raw JSON.' +
        BOARD_SCOPE_NOTE,
      inputSchema: listSchema('sticky'),
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_list_sticky_notes', async (params) => {
      try {
        return await handleList(TYPE_STICKY, params, 'sticky notes');
      } catch (err) {
        return toolError(`List sticky notes failed: ${err.message}`);
      }
    })
  );

  // ---- planko_list_all ----
  server.registerTool(
    'planko_list_all',
    {
      title: 'List all items',
      description: 'List Planko tasks, sticky notes AND notes together in one result. Runs two backend queries (tasks + sticky notes; notes) with the same filters and merges them by sortBy (default updatedAt:desc), cut to `limit`; there is no page parameter. All filters are optional; omit any the user did not explicitly ask for. Returns a concise summary, not raw JSON.' +
        BOARD_SCOPE_NOTE,
      inputSchema: listSchema('all'),
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_list_all', async (params) => {
      try {
        const limit = params.limit || 50;
        const taskParams = await buildListParams(undefined, { ...params, limit, page: 1 });
        const noteParams = { ...taskParams, type: TYPE_NOTE };
        const [taskRes, noteRes] = await Promise.all([api.listTasks(taskParams), api.listTasks(noteParams)]);
        const t = applyAssigneeName(taskRes, params.assigneeName);
        const n = applyAssigneeName(noteRes, params.assigneeName);
        const out = renderAll(mergeAllLists(t.result, n.result, limit, params.sortBy));
        const notes = [t.note, n.note].filter(Boolean);
        return toolOk(notes.length ? `${out}\n\nNote: ${notes.join(' ')}` : out);
      } catch (err) {
        return toolError(`List all failed: ${err.message}`);
      }
    })
  );

  /** Shared view handler: the type shown comes from the item itself. */
  async function handleView(taskId) {
    const res = await api.getTask(taskId);
    const item = unwrapItem(res);
    assertProjectAllowed(PROJECT_LOCK, item);
    return toolOk(renderItem(item));
  }

  // ---- planko_view_task ----
  server.registerTool(
    'planko_view_task',
    {
      title: 'View task',
      description: 'View one Planko task by id, with its description rendered as Markdown. The type is informational — this endpoint returns the item regardless of task/note/sticky-note type.',
      inputSchema: {
        taskId: objectId.describe('Id of the task to view (required)'),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_view_task', async ({ taskId }) => {
      try {
        return await handleView(taskId);
      } catch (err) {
        return toolError(`View task failed: ${err.message}`);
      }
    })
  );

  // ---- planko_view_note ----
  server.registerTool(
    'planko_view_note',
    {
      title: 'View note',
      description: 'View one Planko note by id, with its description rendered as Markdown. The type is informational — this endpoint returns the item regardless of task/note/sticky-note type.',
      inputSchema: {
        taskId: objectId.describe('Id of the note to view (required)'),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_view_note', async ({ taskId }) => {
      try {
        return await handleView(taskId);
      } catch (err) {
        return toolError(`View note failed: ${err.message}`);
      }
    })
  );

  // ---- planko_view_sticky_note ----
  server.registerTool(
    'planko_view_sticky_note',
    {
      title: 'View sticky note',
      description: 'View one Planko sticky note by id, with its description rendered as Markdown. The type is informational — this endpoint returns the item regardless of task/note/sticky-note type.',
      inputSchema: {
        taskId: objectId.describe('Id of the sticky note to view (required)'),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    wrapHandler('planko_view_sticky_note', async ({ taskId }) => {
      try {
        return await handleView(taskId);
      } catch (err) {
        return toolError(`View sticky note failed: ${err.message}`);
      }
    })
  );
}
