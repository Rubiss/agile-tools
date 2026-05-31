#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

class JiraRequestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "JiraRequestError";
    this.status = status;
    this.body = body;
  }
}

const execFile = promisify(execFileCallback);
const BOOTSTRAP_DATASET_VERSION = 4;
const MIN_COMPLETED_STORY_COUNT = 72;
const MIN_IN_PROGRESS_STORY_COUNT = 10;
const SELECTED_ONLY_ACTIVE_STORY_INTERVAL = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FORECAST_HISTORY_WINDOW_DAYS = 90;

const config = loadConfig();

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  console.log(`Waiting for Jira at ${config.baseUrl}`);
  await waitForAuthenticatedJira();

  const currentUser = await jiraRequest("/rest/api/2/myself");
  const projectResult = await ensureProject(currentUser);
  const board = await ensureBoard(projectResult.project, projectResult.created);
  const issuePlans = buildIssuePlan();
  const issues = await ensureSampleIssues(projectResult.project.key, issuePlans);
  const pat = config.createPat ? await ensurePat() : null;

  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.publicBaseUrl,
    seededDataset: summarizeIssuePlan(issuePlans),
    username: config.username,
    project: {
      id: projectResult.project.id,
      key: projectResult.project.key,
      name: projectResult.project.name,
      created: projectResult.created,
    },
    board,
    issues,
    pat,
    agileToolsConnection: {
      baseUrl: config.publicBaseUrl,
      boardId: board.id,
      projectKey: projectResult.project.key,
      token: pat?.token ?? null,
      username: config.username,
    },
  };

  await writeBootstrapOutput(output);
  console.log(`Bootstrap summary written to ${config.outputPath}`);
}

function loadConfig() {
  const projectKey = requiredEnv("JIRA_BOOTSTRAP_PROJECT_KEY", "AGILE").toUpperCase();

  return {
    baseUrl: normalizeUrl(requiredEnv("JIRA_BOOTSTRAP_BASE_URL", "http://jira:8080")),
    publicBaseUrl: normalizeUrl(
      requiredEnv("JIRA_BOOTSTRAP_PUBLIC_BASE_URL", "http://localhost:8080"),
    ),
    username: requiredEnv("JIRA_BOOTSTRAP_USERNAME"),
    password: requiredEnv("JIRA_BOOTSTRAP_PASSWORD"),
    projectKey,
    projectName: requiredEnv("JIRA_BOOTSTRAP_PROJECT_NAME", "Agile Tools Local Demo"),
    boardName: requiredEnv("JIRA_BOOTSTRAP_BOARD_NAME", "Agile Tools Kanban"),
    filterName: requiredEnv(
      "JIRA_BOOTSTRAP_FILTER_NAME",
      "Agile Tools Kanban Filter",
    ),
    issueLabel: requiredEnv("JIRA_BOOTSTRAP_ISSUE_LABEL", "agile-tools-bootstrap"),
    sampleIssueCount: readPositiveInt(
      "JIRA_BOOTSTRAP_SAMPLE_ISSUE_COUNT",
      MIN_COMPLETED_STORY_COUNT + MIN_IN_PROGRESS_STORY_COUNT,
    ),
    completedStoryCount: Math.max(
      MIN_COMPLETED_STORY_COUNT,
      readPositiveInt("JIRA_BOOTSTRAP_COMPLETED_STORY_COUNT", MIN_COMPLETED_STORY_COUNT),
    ),
    inProgressStoryCount: Math.max(
      MIN_IN_PROGRESS_STORY_COUNT,
      readPositiveInt("JIRA_BOOTSTRAP_IN_PROGRESS_STORY_COUNT", MIN_IN_PROGRESS_STORY_COUNT),
    ),
    resetIssues: readBoolean("JIRA_BOOTSTRAP_RESET_ISSUES", true),
    waitTimeoutMs: readPositiveInt("JIRA_BOOTSTRAP_WAIT_TIMEOUT_MS", 600000),
    waitIntervalMs: readPositiveInt("JIRA_BOOTSTRAP_WAIT_INTERVAL_MS", 5000),
    createPat: readBoolean("JIRA_BOOTSTRAP_CREATE_PAT", true),
    patName: requiredEnv("JIRA_BOOTSTRAP_PAT_NAME", "agile-tools-local"),
    patExpirationDays: readPositiveInt(
      "JIRA_BOOTSTRAP_PAT_EXPIRATION_DAYS",
      30,
    ),
    outputPath: requiredEnv(
      "JIRA_BOOTSTRAP_OUTPUT_PATH",
      "/bootstrap-output/jira-bootstrap.json",
    ),
    dbHost: requiredEnv("JIRA_BOOTSTRAP_DB_HOST", "jira-db"),
    dbPort: readPositiveInt("JIRA_BOOTSTRAP_DB_PORT", 5432),
    dbName: requiredEnv("JIRA_BOOTSTRAP_DB_NAME", "jira"),
    dbUser: requiredEnv("JIRA_BOOTSTRAP_DB_USER", "jira"),
    dbPassword: requiredEnv("JIRA_BOOTSTRAP_DB_PASSWORD", "jira"),
  };
}

function requiredEnv(name, defaultValue) {
  const value = process.env[name] ?? defaultValue;

  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for Jira bootstrap`);
  }

  return value.trim();
}

function readPositiveInt(name, defaultValue) {
  const raw = process.env[name];

  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readBoolean(name, defaultValue) {
  const raw = process.env[name];

  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}

function buildUrl(path, query) {
  const url = new URL(path, `${config.baseUrl}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

function createAuthHeader(auth) {
  if (!auth || auth.type === "basic") {
    return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }

  if (auth.type === "bearer") {
    return `Bearer ${auth.token}`;
  }

  throw new Error(`Unsupported auth type: ${auth.type}`);
}

async function jiraRequest(path, options = {}) {
  const { method = "GET", query, body, auth, headers } = options;
  const response = await fetch(buildUrl(path, query), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: createAuthHeader(auth),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null;
  }

  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    throw new JiraRequestError(
      `Jira request failed (${response.status}) for ${method} ${path}`,
      response.status,
      responseBody,
    );
  }

  return responseBody;
}

async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function isStatus(error, status) {
  return error instanceof JiraRequestError && error.status === status;
}

async function waitForAuthenticatedJira() {
  const deadline = Date.now() + config.waitTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const currentUser = await jiraRequest("/rest/api/2/myself");
      const identifier = currentUser.name ?? currentUser.key ?? config.username;
      console.log(`Authenticated to Jira as ${identifier}`);
      return;
    } catch (error) {
      if (
        error instanceof JiraRequestError &&
        [401, 403, 404, 429, 500, 502, 503].includes(error.status)
      ) {
        console.log(
          "Jira is not ready for authenticated API calls yet. Finish the setup wizard and keep the stack running.",
        );
        await delay(config.waitIntervalMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Timed out waiting for Jira. Finish the first-run setup wizard, confirm the admin credentials, and rerun the bootstrap step.",
  );
}

async function ensureProject(currentUser) {
  const existing = await getProject(config.projectKey);

  if (existing) {
    console.log(`Using existing Jira project ${existing.key}`);
    return { project: existing, created: false };
  }

  const projectLead = currentUser.name ?? currentUser.key ?? config.username;
  console.log(`Creating Jira project ${config.projectKey}`);

  const created = await jiraRequest("/rest/api/2/project", {
    method: "POST",
    body: {
      assigneeType: "PROJECT_LEAD",
      description: "Local Jira project seeded for Agile Tools testing",
      key: config.projectKey,
      lead: projectLead,
      name: config.projectName,
      projectTemplateKey: "com.pyxis.greenhopper.jira:gh-kanban-template",
      projectTypeKey: "software",
    },
  });

  const project = (await getProject(created.key ?? config.projectKey)) ?? created;
  return { project, created: true };
}

async function getProject(projectKey) {
  try {
    return await jiraRequest(`/rest/api/2/project/${encodeURIComponent(projectKey)}`);
  } catch (error) {
    if (isStatus(error, 404)) {
      return null;
    }

    throw error;
  }
}

async function ensureBoard(project, waitForTemplateBoard) {
  const existing = waitForTemplateBoard
    ? await waitForBoard(project.key, 6)
    : await findBoard(project.key);

  if (existing) {
    console.log(`Using existing Jira board ${existing.name} (${existing.id})`);
    return getBoardDetails(existing.id);
  }

  const filter = await createFilter(project.key);
  console.log(`Creating Jira board ${config.boardName}`);
  const created = await jiraRequest("/rest/agile/1.0/board", {
    method: "POST",
    body: {
      filterId: Number(filter.id),
      name: config.boardName,
      type: "kanban",
    },
  });

  return getBoardDetails(created.id);
}

async function waitForBoard(projectKey, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const board = await findBoard(projectKey);

    if (board) {
      return board;
    }

    await delay(config.waitIntervalMs);
  }

  return null;
}

async function findBoard(projectKey) {
  const boards = await jiraRequest("/rest/agile/1.0/board", {
    query: {
      maxResults: 50,
      projectKeyOrId: projectKey,
      type: "kanban",
    },
  });

  const values = boards.values ?? [];
  return (
    values.find((board) => board.name === config.boardName) ??
    values[0] ??
    null
  );
}

async function createFilter(projectKey) {
  console.log(`Creating Jira filter ${config.filterName}`);
  return jiraRequest("/rest/api/2/filter", {
    method: "POST",
    body: {
      description: "Filter seeded for local Agile Tools testing",
      jql: `project = ${projectKey} ORDER BY Rank ASC`,
      name: config.filterName,
    },
  });
}

async function getBoardDetails(boardId) {
  const [board, configuration] = await Promise.all([
    jiraRequest(`/rest/agile/1.0/board/${boardId}`),
    jiraRequest(`/rest/agile/1.0/board/${boardId}/configuration`),
  ]);

  return {
    filterId: configuration?.filter?.id ?? null,
    id: board.id,
    name: board.name,
    type: board.type,
  };
}

async function ensureSampleIssues(projectKey, issuePlans) {
  const bootstrapJql = buildBootstrapIssueJql(projectKey);
  const existing = await searchIssues(bootstrapJql, getBootstrapSearchLimit());

  if (existing.length > 0 && config.resetIssues) {
    console.log(
      `Deleting ${existing.length} existing bootstrap issue(s) so the local demo dataset stays deterministic`,
    );

    for (const issue of existing) {
      await deleteIssue(issue.key);
    }
  }

  if (!config.resetIssues && existing.length >= issuePlans.length) {
    console.log(`Reusing ${existing.length} bootstrap issue(s)`);
    return existing;
  }

  const issueType = await chooseIssueType(projectKey);
  const issuesToCreate = config.resetIssues
    ? issuePlans
    : issuePlans.slice(existing.length);

  for (const issuePlan of issuesToCreate) {
    const createdIssue = await createIssue(projectKey, issueType, issuePlan);
    const appliedTransitions = await applyTransitions(createdIssue.key, issuePlan.transitions);
    await backfillIssueHistory(createdIssue, issuePlan, appliedTransitions);
  }

  return searchIssues(bootstrapJql, getBootstrapSearchLimit());
}

function buildBootstrapIssueJql(projectKey) {
  const label = escapeJqlStringLiteral(config.issueLabel);
  return `project = ${projectKey} AND labels = "${label}" ORDER BY created ASC`;
}

function escapeJqlStringLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildIssuePlan(referenceNow = new Date()) {
  const completedStories = buildCompletedStoryPlans(referenceNow);
  const inProgressStories = buildInProgressStoryPlans(referenceNow);
  const backlogStories = buildBacklogStoryPlans(
    referenceNow,
    Math.max(0, getTargetIssueCount() - completedStories.length - inProgressStories.length),
  );

  return [...completedStories, ...inProgressStories, ...backlogStories];
}

function buildCompletedStoryPlans(referenceNow) {
  const maxCompletedDaysAgo = Math.max(1, FORECAST_HISTORY_WINDOW_DAYS - 2);

  return Array.from({ length: config.completedStoryCount }, (_, index) => {
    const storyNumber = padSequence(index + 1);
    const cycleTimeDays = 2 + index;
    const completedDaysAgo = 1 + Math.floor(
      (index * maxCompletedDaysAgo) / Math.max(config.completedStoryCount - 1, 1),
    );
    const selectedDaysAgo = completedDaysAgo + cycleTimeDays;
    const inProgressDaysAgo = completedDaysAgo + Math.max(0.5, Math.ceil(cycleTimeDays * 0.45));
    const createdDaysAgo = selectedDaysAgo + 1 + (index % 3);

    return {
      createdAt: timestampDaysAgo(referenceNow, createdDaysAgo, index, 8),
      description:
        `Bootstrap story fixture completed ${completedDaysAgo} day(s) ago ` +
        `with a ${cycleTimeDays}-day cycle time.`,
      seedState: "done",
      summary: `[AT] Story Done ${storyNumber} (${cycleTimeDays}d cycle)`,
      transitions: [
        {
          changedAt: timestampDaysAgo(referenceNow, selectedDaysAgo, index, 9),
          preferredNames: ["Selected for Development", "In Progress", "Doing"],
        },
        {
          changedAt: timestampDaysAgo(referenceNow, inProgressDaysAgo, index, 10),
          preferredNames: ["In Progress", "Doing"],
        },
        {
          changedAt: timestampDaysAgo(referenceNow, completedDaysAgo, index, 11),
          preferredNames: ["Done", "Closed", "Resolved"],
        },
      ],
    };
  });
}

function buildInProgressStoryPlans(referenceNow) {
  const baseAges = [1, 2, 3, 5, 7, 9, 12, 16, 21, 27];

  return Array.from({ length: config.inProgressStoryCount }, (_, index) => {
    const storyNumber = padSequence(index + 1);
    const ageDays = baseAges[index] ?? (baseAges[baseAges.length - 1] + ((index - baseAges.length + 1) * 4));
    const staysSelected = index % SELECTED_ONLY_ACTIVE_STORY_INTERVAL === 0;
    const inProgressDaysAgo = Math.max(0.25, Number((ageDays * 0.45).toFixed(2)));
    const createdDaysAgo = ageDays + 1 + (index % 2);

    return {
      createdAt: timestampDaysAgo(referenceNow, createdDaysAgo, index, 8),
      description: staysSelected
        ? `Bootstrap story fixture actively selected for roughly ${ageDays} day(s).`
        : `Bootstrap story fixture actively in progress for roughly ${ageDays} day(s).`,
      seedState: "in-progress",
      summary: `[AT] Story ${staysSelected ? "Selected" : "In Progress"} ${storyNumber} (${ageDays}d age)`,
      transitions: [
        {
          changedAt: timestampDaysAgo(referenceNow, ageDays, index, 9),
          preferredNames: ["Selected for Development", "In Progress", "Doing"],
        },
        ...(staysSelected ? [] : [
          {
            changedAt: timestampDaysAgo(referenceNow, inProgressDaysAgo, index, 10),
            preferredNames: ["In Progress", "Doing"],
          },
        ]),
      ],
    };
  });
}

function buildBacklogStoryPlans(referenceNow, backlogCount) {
  return Array.from({ length: backlogCount }, (_, index) => ({
    createdAt: timestampDaysAgo(referenceNow, 1 + index, index, 8),
    description: "Bootstrap story fixture left in backlog so the seeded board is not exclusively active work.",
    seedState: "backlog",
    summary: `[AT] Story Backlog ${padSequence(index + 1)}`,
    transitions: [],
  }));
}

function summarizeIssuePlan(issuePlans) {
  return {
    version: BOOTSTRAP_DATASET_VERSION,
    completedStories: issuePlans.filter((plan) => plan.seedState === "done").length,
    inProgressStories: issuePlans.filter((plan) => plan.seedState === "in-progress").length,
    backlogStories: issuePlans.filter((plan) => plan.seedState === "backlog").length,
  };
}

function padSequence(value) {
  return String(value).padStart(2, "0");
}

function timestampDaysAgo(referenceNow, daysAgo, sequence, hour) {
  const timestamp = new Date(referenceNow.getTime() - (daysAgo * MS_PER_DAY));
  timestamp.setUTCHours(hour, (sequence * 7) % 60, 0, 0);
  return timestamp;
}

function getTargetIssueCount() {
  return Math.max(
    config.sampleIssueCount,
    config.completedStoryCount + config.inProgressStoryCount,
  );
}

function getBootstrapSearchLimit() {
  return Math.max(getTargetIssueCount() + 20, 200);
}

async function chooseIssueType(projectKey) {
  const statusGroups = await jiraRequest(
    `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`,
  );
  const preferred = ["Story", "Task", "Bug"];
  const issueTypes = Array.isArray(statusGroups) ? statusGroups : [];

  for (const preferredName of preferred) {
    const match = issueTypes.find((issueType) => issueType.name === preferredName);
    if (match) {
      return { id: match.id, name: match.name };
    }
  }

  const fallback = issueTypes[0];

  if (!fallback) {
    throw new Error(
      `Jira project ${projectKey} did not return any issue types from /statuses`,
    );
  }

  return { id: fallback.id, name: fallback.name };
}

async function createIssue(projectKey, issueType, issuePlan) {
  console.log(`Creating Jira issue ${issuePlan.summary}`);
  return jiraRequest("/rest/api/2/issue", {
    method: "POST",
    body: {
      fields: {
        description: issuePlan.description,
        issuetype: { id: issueType.id },
        labels: [config.issueLabel],
        project: { key: projectKey },
        summary: issuePlan.summary,
      },
    },
  });
}

async function applyTransitions(issueKey, transitionPlans) {
  const appliedTransitions = [];

  for (const transitionPlan of transitionPlans) {
    const transitioned = await transitionIssue(issueKey, transitionPlan.preferredNames);

    if (!transitioned) {
      console.log(
        `No matching Jira transition found for ${issueKey}: ${transitionPlan.preferredNames.join(", ")}`,
      );

      continue;
    }

    appliedTransitions.push(transitionPlan);
  }

  return appliedTransitions;
}

async function transitionIssue(issueKey, preferredNames) {
  const response = await jiraRequest(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
  );
  const transitions = response.transitions ?? [];
  const preferredSet = new Set(preferredNames.map((name) => name.toLowerCase()));
  const match = transitions.find((transition) => {
    const transitionName = transition.name?.toLowerCase();
    const destinationName = transition.to?.name?.toLowerCase();
    return preferredSet.has(transitionName) || preferredSet.has(destinationName);
  });

  if (!match) {
    return false;
  }

  await jiraRequest(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      method: "POST",
      body: {
        transition: {
          id: match.id,
        },
      },
    },
  );

  return true;
}

async function backfillIssueHistory(issue, issuePlan, appliedTransitions) {
  const changeGroupIds = await loadStatusChangeGroupIds(issue.id);

  if (changeGroupIds.length !== appliedTransitions.length) {
    throw new Error(
      `Expected ${appliedTransitions.length} status change groups for ${issue.key}, found ${changeGroupIds.length}`,
    );
  }

  const updatedAt = appliedTransitions.length > 0
    ? appliedTransitions[appliedTransitions.length - 1].changedAt
    : issuePlan.createdAt;

  const statements = [
    "BEGIN;",
    `UPDATE jiraissue SET created = ${sqlTimestamp(issuePlan.createdAt)}, updated = ${sqlTimestamp(updatedAt)} WHERE id = ${sqlNumeric(issue.id)};`,
    ...changeGroupIds.map(
      (id, index) =>
        `UPDATE changegroup SET created = ${sqlTimestamp(appliedTransitions[index].changedAt)} WHERE id = ${sqlNumeric(id)};`,
    ),
    "COMMIT;",
  ];

  await runPsql(statements.join("\n"));
  await reindexIssue(issue.id);
}

async function loadStatusChangeGroupIds(issueId) {
  const output = await runPsql(`
    SELECT cg.id
    FROM changegroup cg
    JOIN changeitem ci ON ci.groupid = cg.id
    WHERE cg.issueid = ${sqlNumeric(issueId)}
      AND ci.field = 'status'
    GROUP BY cg.id, cg.created
    ORDER BY cg.created ASC, cg.id ASC;
  `);

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function runPsql(sql) {
  const { stdout } = await execFile(
    "psql",
    [
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      config.dbHost,
      "-p",
      String(config.dbPort),
      "-U",
      config.dbUser,
      "-d",
      config.dbName,
      "-t",
      "-A",
      "-c",
      sql,
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: config.dbPassword,
      },
    },
  );

  return stdout.trim();
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTimestamp(value) {
  return `${sqlLiteral(value.toISOString())}::timestamptz`;
}

function sqlNumeric(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected numeric SQL value, received: ${value}`);
  }

  return String(Math.trunc(numeric));
}

async function reindexIssue(issueId) {
  await jiraRequest("/rest/api/2/reindex/issue", {
    method: "POST",
    query: {
      indexChangeHistory: true,
      issueId,
    },
  });
}

async function deleteIssue(issueKey) {
  console.log(`Deleting Jira issue ${issueKey}`);
  await jiraRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
    method: "DELETE",
    query: {
      deleteSubtasks: true,
    },
  });
}

async function searchIssues(jql, maxResults = getBootstrapSearchLimit()) {
  const searchResult = await jiraRequest("/rest/api/2/search", {
    query: {
      fields: "summary,status,issuetype,created,updated",
      jql,
      maxResults,
    },
  });

  return (searchResult.issues ?? []).map((issue) => ({
    createdAt: issue.fields?.created ?? null,
    id: issue.id,
    issueType: issue.fields?.issuetype?.name ?? null,
    key: issue.key,
    status: issue.fields?.status?.name ?? null,
    summary: issue.fields?.summary ?? null,
    updatedAt: issue.fields?.updated ?? null,
  }));
}

async function ensurePat() {
  const previousOutput = await readBootstrapOutput();
  const previousToken = previousOutput?.pat?.token;

  if (previousToken && (await isExistingPatValid(previousToken))) {
    console.log(`Reusing PAT ${previousOutput.pat.name}`);
    return previousOutput.pat;
  }

  try {
    console.log(`Creating Jira PAT ${config.patName}`);
    const response = await jiraRequest("/rest/pat/latest/tokens", {
      method: "POST",
      body: {
        expirationDuration: config.patExpirationDays,
        name: config.patName,
      },
    });
    const token = extractPatToken(response);

    return {
      expirationDays: config.patExpirationDays,
      name: config.patName,
      raw: response,
      token,
    };
  } catch (error) {
    if (error instanceof JiraRequestError) {
      console.warn(
        `Skipping PAT creation because Jira returned ${error.status}. Create a PAT manually in Jira if PATs are disabled on this instance.`,
      );
      return null;
    }

    throw error;
  }
}

async function isExistingPatValid(token) {
  try {
    await jiraRequest("/rest/api/2/myself", {
      auth: {
        token,
        type: "bearer",
      },
    });
    return true;
  } catch {
    return false;
  }
}

function extractPatToken(response) {
  if (typeof response === "string" && response.trim().length > 0) {
    return response.trim();
  }

  const candidates = [
    response?.token,
    response?.rawToken,
    response?.accessToken,
    response?.value,
  ];

  const match = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );

  if (!match) {
    throw new Error(
      `Jira PAT response did not include a recognizable token field: ${JSON.stringify(response)}`,
    );
  }

  return match;
}

async function readBootstrapOutput() {
  try {
    const existing = await readFile(config.outputPath, "utf8");
    return JSON.parse(existing);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeBootstrapOutput(output) {
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
