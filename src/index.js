"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");
const { z } = require("zod");

const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createIssueSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20000).nullable().optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  projectId: z.string().uuid(),
  goalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  billingCode: z.string().trim().max(255).nullable().optional(),
  labelIds: z.array(z.string().uuid()).max(50).optional().default([]),
});

const addCommentSchema = z.object({
  body: z.string().trim().min(1).max(20000),
});

const updateIssueSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(20000).nullable().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  billingCode: z.string().trim().max(255).nullable().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one field must be provided",
});

const listIssuesQuerySchema = z.object({
  companyId: z.string().uuid(),
  status: z.enum(ISSUE_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
});

const listProjectsQuerySchema = z.object({
  companyId: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
});

const listAgentsQuerySchema = z.object({
  companyId: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
});

function envBool(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 4310),
  trustProxy: envBool(process.env.TRUST_PROXY, false),
  bodyLimit: process.env.BODY_LIMIT || "64kb",
  databaseUrl: process.env.DATABASE_URL,
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({
  connectionString: config.databaseUrl,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.use(express.json({ limit: config.bodyLimit }));

function getSessionToken(req) {
  const auth = req.header("authorization");
  if (auth) {
    const match = auth.match(/^session\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  const headerToken = req.header("x-session-token");
  if (headerToken && headerToken.trim()) {
    return headerToken.trim();
  }
  return null;
}

async function requireSessionUser(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing session token" });
    return;
  }

  try {
    const { rows } = await pool.query(
      `select s.id, s.user_id, s.expires_at, u.email, u.name
       from public.session s
       join public."user" u on u.id = s.user_id
       where s.token = $1
       limit 1`,
      [token],
    );
    const session = rows[0];
    if (!session) {
      res.status(401).json({ error: "Invalid session token" });
      return;
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      res.status(401).json({ error: "Session token expired" });
      return;
    }
    req.sessionUser = {
      sessionId: session.id,
      userId: session.user_id,
      email: session.email,
      name: session.name,
    };
    next();
  } catch (error) {
    next(error);
  }
}

async function assertCompanyAccess(client, userId, companyId) {
  const { rows } = await client.query(
    `select 1
     from public.company_memberships
     where company_id = $1
       and principal_type = 'user'
       and principal_id = $2
       and status = 'active'
     limit 1`,
    [companyId, userId],
  );
  return rows.length > 0;
}

async function resolveIssueForUser(client, userId, issueRef) {
  const byField = UUID_RE.test(issueRef) ? "i.id" : "i.identifier";
  const { rows } = await client.query(
    `select i.id, i.company_id, i.identifier, i.title, i.status
     from public.issues i
     where ${byField} = $1
       and exists (
         select 1
         from public.company_memberships cm
         where cm.company_id = i.company_id
           and cm.principal_type = 'user'
           and cm.principal_id = $2
           and cm.status = 'active'
       )
     limit 1`,
    [issueRef, userId],
  );
  return rows[0] || null;
}

async function fetchIssueDetailsForUser(client, userId, issueRef) {
  const byField = UUID_RE.test(issueRef) ? "i.id" : "i.identifier";
  const { rows } = await client.query(
    `select
       i.id,
       i.company_id as "companyId",
       i.project_id as "projectId",
       i.goal_id as "goalId",
       i.parent_id as "parentId",
       i.identifier,
       i.issue_number as "issueNumber",
       i.title,
       i.description,
       i.status,
       i.priority,
       i.assignee_agent_id as "assigneeAgentId",
       i.assignee_user_id as "assigneeUserId",
       i.created_by_user_id as "createdByUserId",
       i.created_at as "createdAt",
       i.updated_at as "updatedAt",
       i.hidden_at as "hiddenAt",
       i.billing_code as "billingCode"
     from public.issues i
     where ${byField} = $1
       and exists (
         select 1
         from public.company_memberships cm
         where cm.company_id = i.company_id
           and cm.principal_type = 'user'
           and cm.principal_id = $2
           and cm.status = 'active'
       )
     limit 1`,
    [issueRef, userId],
  );
  return rows[0] || null;
}

async function fetchProjectDetailsForUser(client, userId, projectId) {
  const { rows } = await client.query(
    `select
       p.id,
       p.company_id as "companyId",
       p.goal_id as "goalId",
       p.name,
       p.description,
       p.status,
       p.lead_agent_id as "leadAgentId",
       p.target_date as "targetDate",
       p.color,
       p.archived_at as "archivedAt",
       p.paused_at as "pausedAt",
       p.pause_reason as "pauseReason",
       p.created_at as "createdAt",
       p.updated_at as "updatedAt"
     from public.projects p
     where p.id = $1
       and exists (
         select 1
         from public.company_memberships cm
         where cm.company_id = p.company_id
           and cm.principal_type = 'user'
           and cm.principal_id = $2
           and cm.status = 'active'
       )
     limit 1`,
    [projectId, userId],
  );
  return rows[0] || null;
}

async function logActivity(client, entry) {
  await client.query(
    `insert into public.activity_log (
       id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
    [
      crypto.randomUUID(),
      entry.companyId,
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.details || null),
    ],
  );
}

function mapIssueRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    goalId: row.goalId,
    parentId: row.parentId,
    identifier: row.identifier,
    issueNumber: row.issueNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hiddenAt: row.hiddenAt,
    billingCode: row.billingCode,
  };
}

function mapProjectRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    goalId: row.goalId,
    name: row.name,
    description: row.description,
    status: row.status,
    leadAgentId: row.leadAgentId,
    targetDate: row.targetDate,
    color: row.color,
    archivedAt: row.archivedAt,
    pausedAt: row.pausedAt,
    pauseReason: row.pauseReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAgentRow(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    role: row.role,
    title: row.title,
    status: row.status,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    lastHeartbeatAt: row.lastHeartbeatAt,
    icon: row.icon,
    pausedAt: row.pausedAt,
    pauseReason: row.pauseReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

app.get("/healthz", async (_req, res, next) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/companies", requireSessionUser, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `select
         c.id,
         c.name,
         c.description,
         c.status,
         c.issue_prefix as "issuePrefix",
         c.created_at as "createdAt",
         c.updated_at as "updatedAt",
         cm.membership_role as "membershipRole"
       from public.company_memberships cm
       join public.companies c on c.id = cm.company_id
       where cm.principal_type = 'user'
         and cm.principal_id = $1
         and cm.status = 'active'
       order by c.name asc`,
      [req.sessionUser.userId],
    );

    res.json(rows);
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/projects", requireSessionUser, async (req, res, next) => {
  const parsed = listProjectsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return;
  }

  const { companyId, limit } = parsed.data;
  const client = await pool.connect();
  try {
    const allowed = await assertCompanyAccess(client, req.sessionUser.userId, companyId);
    if (!allowed) {
      res.status(403).json({ error: "User does not have access to this company" });
      return;
    }

    const { rows } = await client.query(
      `select
         p.id,
         p.company_id as "companyId",
         p.goal_id as "goalId",
         p.name,
         p.description,
         p.status,
         p.lead_agent_id as "leadAgentId",
         p.target_date as "targetDate",
         p.color,
         p.archived_at as "archivedAt",
         p.paused_at as "pausedAt",
         p.pause_reason as "pauseReason",
         p.created_at as "createdAt",
         p.updated_at as "updatedAt"
       from public.projects p
       where p.company_id = $1
       order by p.created_at desc
       limit $2`,
      [companyId, limit],
    );

    res.json(rows.map(mapProjectRow));
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/projects/:projectId", requireSessionUser, async (req, res, next) => {
  if (!UUID_RE.test(req.params.projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const client = await pool.connect();
  try {
    const project = await fetchProjectDetailsForUser(client, req.sessionUser.userId, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found or not accessible" });
      return;
    }

    res.json(mapProjectRow(project));
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/agents", requireSessionUser, async (req, res, next) => {
  const parsed = listAgentsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return;
  }

  const { companyId, limit } = parsed.data;
  const client = await pool.connect();
  try {
    const allowed = await assertCompanyAccess(client, req.sessionUser.userId, companyId);
    if (!allowed) {
      res.status(403).json({ error: "User does not have access to this company" });
      return;
    }

    const { rows } = await client.query(
      `select
         a.id,
         a.company_id as "companyId",
         a.name,
         a.role,
         a.title,
         a.status,
         a.reports_to as "reportsTo",
         a.capabilities,
         a.adapter_type as "adapterType",
         a.last_heartbeat_at as "lastHeartbeatAt",
         a.icon,
         a.paused_at as "pausedAt",
         a.pause_reason as "pauseReason",
         a.created_at as "createdAt",
         a.updated_at as "updatedAt"
       from public.agents a
       where a.company_id = $1
       order by a.created_at asc
       limit $2`,
      [companyId, limit],
    );

    res.json(rows.map(mapAgentRow));
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/issues", requireSessionUser, async (req, res, next) => {
  const parsed = listIssuesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return;
  }

  const { companyId, status, limit } = parsed.data;
  const client = await pool.connect();
  try {
    const allowed = await assertCompanyAccess(client, req.sessionUser.userId, companyId);
    if (!allowed) {
      res.status(403).json({ error: "User does not have access to this company" });
      return;
    }

    const values = [companyId];
    let sql = `select
        i.id,
        i.company_id as "companyId",
        i.project_id as "projectId",
        i.goal_id as "goalId",
        i.parent_id as "parentId",
        i.identifier,
        i.issue_number as "issueNumber",
        i.title,
        i.description,
        i.status,
        i.priority,
        i.assignee_agent_id as "assigneeAgentId",
        i.assignee_user_id as "assigneeUserId",
        i.created_by_user_id as "createdByUserId",
        i.created_at as "createdAt",
        i.updated_at as "updatedAt",
        i.hidden_at as "hiddenAt"
      from public.issues i
      where i.company_id = $1`;

    if (status) {
      values.push(status);
      sql += ` and i.status = $${values.length}`;
    }

    values.push(limit);
    sql += ` order by i.created_at desc limit $${values.length}`;

    const { rows } = await client.query(sql, values);
    res.json(rows.map(mapIssueRow));
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/issues/:issueRef", requireSessionUser, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const issueRef = req.params.issueRef;
    const byField = UUID_RE.test(issueRef) ? "i.id" : "i.identifier";
    const { rows } = await client.query(
      `select
         i.id,
         i.company_id as "companyId",
         i.project_id as "projectId",
         i.goal_id as "goalId",
         i.parent_id as "parentId",
         i.identifier,
         i.issue_number as "issueNumber",
         i.title,
         i.description,
         i.status,
         i.priority,
         i.assignee_agent_id as "assigneeAgentId",
         i.assignee_user_id as "assigneeUserId",
         i.created_by_user_id as "createdByUserId",
         i.created_at as "createdAt",
         i.updated_at as "updatedAt",
         i.hidden_at as "hiddenAt"
       from public.issues i
       where ${byField} = $1
         and exists (
           select 1
           from public.company_memberships cm
           where cm.company_id = i.company_id
             and cm.principal_type = 'user'
             and cm.principal_id = $2
             and cm.status = 'active'
         )
       limit 1`,
      [issueRef, req.sessionUser.userId],
    );

    if (!rows[0]) {
      res.status(404).json({ error: "Issue not found or not accessible" });
      return;
    }

    res.json(mapIssueRow(rows[0]));
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/v1/issues/:issueRef/comments", requireSessionUser, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const issue = await resolveIssueForUser(client, req.sessionUser.userId, req.params.issueRef);
    if (!issue) {
      res.status(404).json({ error: "Issue not found or not accessible" });
      return;
    }

    const { rows } = await client.query(
      `select
         c.id,
         c.company_id as "companyId",
         c.issue_id as "issueId",
         c.author_agent_id as "authorAgentId",
         c.author_user_id as "authorUserId",
         c.body,
         c.created_at as "createdAt",
         c.updated_at as "updatedAt"
       from public.issue_comments c
       where c.issue_id = $1
       order by c.created_at asc`,
      [issue.id],
    );

    res.json(rows);
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.patch("/v1/issues/:issueRef", requireSessionUser, async (req, res, next) => {
  const parsed = updateIssueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await fetchIssueDetailsForUser(client, req.sessionUser.userId, req.params.issueRef);
    if (!existing) {
      await client.query("rollback");
      res.status(404).json({ error: "Issue not found or not accessible" });
      return;
    }

    const input = parsed.data;
    const assignments = [];
    const values = [];
    const previous = {};

    const fieldMap = [
      ["title", "title"],
      ["description", "description"],
      ["status", "status"],
      ["priority", "priority"],
      ["projectId", "project_id"],
      ["goalId", "goal_id"],
      ["parentId", "parent_id"],
      ["assigneeUserId", "assignee_user_id"],
      ["billingCode", "billing_code"],
    ];

    for (const [inputKey, columnName] of fieldMap) {
      if (Object.prototype.hasOwnProperty.call(input, inputKey)) {
        values.push(input[inputKey] ?? null);
        assignments.push(`${columnName} = $${values.length}`);
        previous[inputKey] = existing[inputKey] ?? null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, "hiddenAt")) {
      values.push(input.hiddenAt ? new Date(input.hiddenAt) : null);
      assignments.push(`hidden_at = $${values.length}`);
      previous.hiddenAt = existing.hiddenAt ?? null;
    }

    values.push(existing.id);
    const { rows } = await client.query(
      `update public.issues
       set ${assignments.join(", ")}, updated_at = now()
       where id = $${values.length}
       returning
         id,
         company_id as "companyId",
         project_id as "projectId",
         goal_id as "goalId",
         parent_id as "parentId",
         identifier,
         issue_number as "issueNumber",
         title,
         description,
         status,
         priority,
         assignee_agent_id as "assigneeAgentId",
         assignee_user_id as "assigneeUserId",
         created_by_user_id as "createdByUserId",
         created_at as "createdAt",
         updated_at as "updatedAt",
         hidden_at as "hiddenAt",
         billing_code as "billingCode"`,
      values,
    );

    const updated = rows[0];

    await logActivity(client, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.sessionUser.userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: existing.id,
      details: {
        ...input,
        identifier: existing.identifier,
        _previous: previous,
      },
    });

    await client.query("commit");
    res.json(mapIssueRow(updated));
  } catch (error) {
    await client.query("rollback");
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/issues", requireSessionUser, async (req, res, next) => {
  const parsed = createIssueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }

  const input = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("begin");

    const allowed = await assertCompanyAccess(client, req.sessionUser.userId, input.companyId);
    if (!allowed) {
      await client.query("rollback");
      res.status(403).json({ error: "User does not have access to this company" });
      return;
    }

    const project = await fetchProjectDetailsForUser(client, req.sessionUser.userId, input.projectId);
    if (!project) {
      await client.query("rollback");
      res.status(404).json({ error: "Project not found or not accessible" });
      return;
    }
    if (project.companyId !== input.companyId) {
      await client.query("rollback");
      res.status(400).json({ error: "Project does not belong to the specified company" });
      return;
    }

    const counterResult = await client.query(
      `update public.companies
       set issue_counter = issue_counter + 1,
           updated_at = now()
       where id = $1
       returning issue_prefix, issue_counter`,
      [input.companyId],
    );

    if (!counterResult.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const counterRow = counterResult.rows[0];
    const issueId = crypto.randomUUID();
    const identifier = `${counterRow.issue_prefix}-${counterRow.issue_counter}`;

    const issueInsert = await client.query(
      `insert into public.issues (
         id,
         company_id,
         project_id,
         goal_id,
         parent_id,
         title,
         description,
         status,
         priority,
         created_by_user_id,
         request_depth,
         billing_code,
         created_at,
         updated_at,
         issue_number,
         identifier,
         assignee_user_id
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, now(), now(), $12, $13, $14
       )
       returning id, company_id as "companyId", identifier, issue_number as "issueNumber", title, description, status, priority, created_by_user_id as "createdByUserId", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        issueId,
        input.companyId,
        input.projectId,
        input.goalId || null,
        input.parentId || null,
        input.title,
        input.description || null,
        input.status,
        input.priority,
        req.sessionUser.userId,
        input.billingCode || null,
        counterRow.issue_counter,
        identifier,
        input.assigneeUserId || null,
      ],
    );

    if (input.labelIds.length > 0) {
      const values = [];
      const placeholders = [];
      for (const labelId of input.labelIds) {
        values.push(crypto.randomUUID(), input.companyId, issueId, labelId);
        const base = values.length - 3;
        placeholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3})`);
      }
      await client.query(
        `insert into public.issue_labels (id, company_id, issue_id, label_id)
         values ${placeholders.join(", ")}`,
        values,
      );
    }

    await logActivity(client, {
      companyId: input.companyId,
      actorType: "user",
      actorId: req.sessionUser.userId,
      action: "issue.created",
      entityType: "issue",
      entityId: issueId,
      details: {
        title: input.title,
        identifier,
      },
    });

    await client.query("commit");
    res.status(201).json(issueInsert.rows[0]);
  } catch (error) {
    await client.query("rollback");
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/issues/:issueRef/comments", requireSessionUser, async (req, res, next) => {
  const parsed = addCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const issue = await resolveIssueForUser(client, req.sessionUser.userId, req.params.issueRef);
    if (!issue) {
      await client.query("rollback");
      res.status(404).json({ error: "Issue not found or not accessible" });
      return;
    }

    const commentId = crypto.randomUUID();
    const commentResult = await client.query(
      `insert into public.issue_comments (
         id,
         company_id,
         issue_id,
         author_user_id,
         body,
         created_at,
         updated_at
       ) values ($1, $2, $3, $4, $5, now(), now())
       returning id, company_id as "companyId", issue_id as "issueId", author_user_id as "authorUserId", body, created_at as "createdAt", updated_at as "updatedAt"`,
      [commentId, issue.company_id, issue.id, req.sessionUser.userId, parsed.data.body],
    );

    await logActivity(client, {
      companyId: issue.company_id,
      actorType: "user",
      actorId: req.sessionUser.userId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId,
        identifier: issue.identifier,
        issueTitle: issue.title,
        bodySnippet: parsed.data.body.slice(0, 120),
      },
    });

    await client.query(
      `update public.issues
       set updated_at = now()
       where id = $1`,
      [issue.id],
    );

    await client.query("commit");
    res.status(201).json({
      ...commentResult.rows[0],
      issueIdentifier: issue.identifier,
    });
  } catch (error) {
    await client.query("rollback");
    next(error);
  } finally {
    client.release();
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`paperclip-session-api listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    pool.end().finally(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
