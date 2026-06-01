import { Prisma, type PrismaClient, type JiraConnection } from '@prisma/client';
import type { ConnectionHealthStatus, JiraChangelogStrategy } from '@prisma/client';

type JiraConnectionClient = PrismaClient | Prisma.TransactionClient;

export interface CreateJiraConnectionInput {
  baseUrl: string;
  encryptedSecretRef: string;
  displayName?: string;
}

export interface UpdateJiraConnectionInput {
  baseUrl: string;
  displayName?: string | null;
  encryptedSecretRef?: string;
  resetValidationState?: boolean;
}

export interface UpdateConnectionHealthInput {
  healthStatus: ConnectionHealthStatus;
  lastValidatedAt?: Date;
  lastHealthyAt?: Date;
  /** Pass `null` to clear the error code. Pass `undefined` to leave unchanged. */
  lastErrorCode?: string | null;
}

export interface UpdateJiraConnectionCapabilitiesInput {
  jiraVersion?: string | null;
  jiraDeploymentType?: string | null;
  changelogStrategy?: JiraChangelogStrategy | null;
  capabilitiesDetectedAt?: Date;
}

export async function createJiraConnection(
  client: JiraConnectionClient,
  workspaceId: string,
  input: CreateJiraConnectionInput,
): Promise<JiraConnection> {
  return client.jiraConnection.create({
    data: {
      workspaceId,
      baseUrl: input.baseUrl,
      displayName: input.displayName ?? null,
      encryptedSecretRef: input.encryptedSecretRef,
      authType: 'pat',
    },
  });
}

export async function getJiraConnection(
  client: JiraConnectionClient,
  workspaceId: string,
  connectionId: string,
): Promise<JiraConnection | null> {
  return client.jiraConnection.findFirst({
    where: { workspaceId, id: connectionId },
  });
}

export async function listJiraConnections(
  client: JiraConnectionClient,
  workspaceId: string,
): Promise<JiraConnection[]> {
  return client.jiraConnection.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Atomically update connection health fields.
 * Returns the updated record or null if the connection does not exist in the workspace.
 */
export async function updateConnectionHealth(
  client: JiraConnectionClient,
  workspaceId: string,
  connectionId: string,
  update: UpdateConnectionHealthInput,
): Promise<JiraConnection | null> {
  const data: Prisma.JiraConnectionUpdateInput = {
    healthStatus: update.healthStatus,
  };
  if (update.lastValidatedAt !== undefined) data.lastValidatedAt = update.lastValidatedAt;
  if (update.lastHealthyAt !== undefined) data.lastHealthyAt = update.lastHealthyAt;
  if (update.lastErrorCode !== undefined) data.lastErrorCode = update.lastErrorCode;

  try {
    return await client.jiraConnection.update({
      where: { workspaceId_id: { workspaceId, id: connectionId } },
      data,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return null;
    }
    throw err;
  }
}

export async function updateJiraConnection(
  client: JiraConnectionClient,
  workspaceId: string,
  connectionId: string,
  input: UpdateJiraConnectionInput,
): Promise<JiraConnection | null> {
  const data: Prisma.JiraConnectionUpdateInput = {
    baseUrl: input.baseUrl,
  };

  if (input.displayName !== undefined) {
    data.displayName = input.displayName;
  }

  if (input.encryptedSecretRef !== undefined) {
    data.encryptedSecretRef = input.encryptedSecretRef;
  }

  if (input.resetValidationState) {
    data.healthStatus = 'draft';
    data.lastValidatedAt = null;
    data.lastHealthyAt = null;
    data.lastErrorCode = null;
    data.jiraVersion = null;
    data.jiraDeploymentType = null;
    data.changelogStrategy = null;
    data.capabilitiesDetectedAt = null;
  }

  try {
    return await client.jiraConnection.update({
      where: { workspaceId_id: { workspaceId, id: connectionId } },
      data,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return null;
    }
    throw err;
  }
}

/**
 * Persist Jira server metadata and detected API capabilities.
 *
 * All fields are optional so callers can update version metadata from
 * `/serverInfo`, changelog strategy from a runtime probe, or both together.
 */
export async function updateJiraConnectionCapabilities(
  client: JiraConnectionClient,
  workspaceId: string,
  connectionId: string,
  input: UpdateJiraConnectionCapabilitiesInput,
): Promise<JiraConnection | null> {
  const data: Prisma.JiraConnectionUpdateInput = {};
  if (input.jiraVersion !== undefined) data.jiraVersion = input.jiraVersion;
  if (input.jiraDeploymentType !== undefined) data.jiraDeploymentType = input.jiraDeploymentType;
  if (input.changelogStrategy !== undefined) data.changelogStrategy = input.changelogStrategy;
  if (input.capabilitiesDetectedAt !== undefined) {
    data.capabilitiesDetectedAt = input.capabilitiesDetectedAt;
  }

  if (Object.keys(data).length === 0) {
    return getJiraConnection(client, workspaceId, connectionId);
  }

  try {
    return await client.jiraConnection.update({
      where: { workspaceId_id: { workspaceId, id: connectionId } },
      data,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return null;
    }
    throw err;
  }
}

export async function deleteJiraConnection(
  client: JiraConnectionClient,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> {
  const result = await client.jiraConnection.deleteMany({
    where: { workspaceId, id: connectionId },
  });
  return result.count > 0;
}
