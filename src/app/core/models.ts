export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  phone: string | null;
  tier: string;
  dailyTokenCap?: number;
}

export type IntelligenceLevel = 'low' | 'medium' | 'high';

export interface IntelligenceOption {
  value: IntelligenceLevel;
  label: string;
  enabled: boolean;
  reason?: string;
  models?: string;
}

export interface Chat {
  id: string;
  projectId?: string | null;
  title: string | null;
  createdAt: string;
  lastActive: string;
  totalTokens?: number;
  snippet?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  id: string;
  projectId: string;
  path: string;
  language: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  /** Stable local render key to avoid remount flicker while temp ids get replaced. */
  clientKey?: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  feedbackType?: 'like' | 'dislike' | null;
  createdAt: string;
}

export interface UsageToday {
  tokens: number;
  cap: number;
  remaining: number;
  pct: number;
  resetsAt: string;
  plan?: {
    tier: 'free' | 'pro' | 'team';
    name: string;
    availableIntelligence: IntelligenceLevel[];
  };
  intelligence?: {
    mediumFallsBackAt: number | null;
    highFallsBackAt: number | null;
    mediumRemainingBeforeDowngrade: number | null;
    highRemainingBeforeDowngrade: number | null;
    mediumDowngradesTo: IntelligenceLevel | null;
    highDowngradesTo: IntelligenceLevel | null;
  };
}

export interface UsageWeek {
  totalTokens: number;
  totalCostUsd: number;
}

export interface ProposedChange {
  path: string;
  language: string | null;
  content: string;
  /** Original file content before the change. null = new file being created. */
  originalContent: string | null;
  /** True when at least one edit block had to be matched fuzzily (whitespace-tolerant). */
  fuzzyApplied?: boolean;
  /** Set when SEARCH/REPLACE blocks could not be located in the file — Apply is disabled. */
  applyError?: string;
  /** Raw SEARCH/REPLACE blocks for the message component to display when applyError is set. */
  editBlocks?: Array<{ search: string; replace: string }>;
}

/** A project file slice that was used as RAG context for an assistant turn. */
export interface UsedContext {
  path: string;
  startLine: number;
  endLine: number;
}

export interface SendResponse {
  requestId: string;
  userMessage?: { id: string; content: string; createdAt: string };
  reply: { id: string; content: string; createdAt: string; model: string; provider: string };
  usage: { tokens: number; promptTokens: number; outputTokens: number; remainingTodayTokens: number };
  routing: {
    escalationLevel: number;
    unresolvedTurns: number;
    usedProjectRag: boolean;
    usedWebGrounding: boolean;
    historyMessages: number;
    bucket: string;
    strategy: string;
    intelligence: IntelligenceLevel;
  };
  downgrade?: {
    requested: IntelligenceLevel;
    used: IntelligenceLevel;
    reason: string;
  };
  followUps?: string[];
  /** Project files actually used as context for this turn (RAG retrieval). */
  usedContext?: UsedContext[];
  /** Proposed file changes parsed out of the model's reply (project mode). Read-only. */
  proposedChanges?: ProposedChange[];
}

export type ModelPriorityTier = 'cheap' | 'mid' | 'premium';

export interface ModelPriorityEntry {
  id: string;
  label: string;
  provider: string;
  tier: string;
}

export interface ModelPriorityGroup {
  tier: ModelPriorityTier;
  label: string;
  defaultOrder: ModelPriorityEntry[];
  modelOrder: ModelPriorityEntry[];
  custom: boolean;
}
