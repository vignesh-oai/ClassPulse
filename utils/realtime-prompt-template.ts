import fs from "node:fs";
import path from "node:path";
import { logInfo, logWarn } from "./call-debug";

const DEFAULT_PROMPT_TEMPLATE_PATH = "prompts/teacher-parent-absence-call.jinja";
const DEFAULT_STUDENT_NAME = "Sam";
const DEFAULT_PARENT_NAME = "Jerry";
const DEFAULT_PARENT_RELATIONSHIP = "father";
const DEFAULT_SCHOOL_NAME = "North Valley Middle School";
const DEFAULT_TEACHER_ROLE = "homeroom teacher";
const DEFAULT_PROMPT_FALLBACK =
  "You are a helpful assistant on a live phone call. You are speaking with a parent about a student's persistent school absence. Stay calm, respectful, and concise.";

type PromptContext = {
  student_name: string;
  parent_name: string;
  parent_relationship: string;
  school_name: string;
  teacher_role: string;
  call_reason_summary: string;
  call_context_from_chat: string;
  call_absence_stats: string;
};

type RuntimeCallPromptContext = {
  reasonSummary?: string | null;
  contextFromChat?: string | null;
  absenceStats?: string | null;
};

function trimOrDefault(rawValue: string | undefined, fallback: string): string {
  const trimmed = rawValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeRuntimePromptValue(
  value: string | null | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return fallback;
  }
  return trimmed;
}

function resolvePromptContext(runtimeContext?: RuntimeCallPromptContext): PromptContext {
  return {
    student_name: trimOrDefault(process.env.CALL_STUDENT_NAME, DEFAULT_STUDENT_NAME),
    parent_name: trimOrDefault(process.env.CALL_PARENT_NAME, DEFAULT_PARENT_NAME),
    parent_relationship: trimOrDefault(
      process.env.CALL_PARENT_RELATIONSHIP,
      DEFAULT_PARENT_RELATIONSHIP,
    ),
    school_name: trimOrDefault(process.env.CALL_SCHOOL_NAME, DEFAULT_SCHOOL_NAME),
    teacher_role: trimOrDefault(process.env.CALL_TEACHER_ROLE, DEFAULT_TEACHER_ROLE),
    call_reason_summary: normalizeRuntimePromptValue(
      runtimeContext?.reasonSummary,
      "Attendance follow-up call about persistent absence.",
    ),
    call_context_from_chat: normalizeRuntimePromptValue(
      runtimeContext?.contextFromChat,
      "No additional context from the chat thread.",
    ),
    call_absence_stats: normalizeRuntimePromptValue(
      runtimeContext?.absenceStats,
      "No absence statistics were provided.",
    ),
  };
}

function resolveTemplatePath(): string {
  const configured =
    process.env.OPENAI_REALTIME_PROMPT_TEMPLATE?.trim() || DEFAULT_PROMPT_TEMPLATE_PATH;
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(process.cwd(), configured);
}

function renderJinjaVariables(template: string, context: PromptContext): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key) => {
    const value = context[key as keyof PromptContext];
    return value ?? match;
  });
}

export function getRealtimeSystemPrompt(runtimeContext?: RuntimeCallPromptContext): string {
  const templatePath = resolveTemplatePath();
  const context = resolvePromptContext(runtimeContext);

  try {
    const template = fs.readFileSync(templatePath, "utf8");
    const rendered = renderJinjaVariables(template, context).trim();
    if (rendered.length > 0) {
      logInfo("Loaded Realtime system prompt from template", {
        templatePath,
        studentName: context.student_name,
        parentName: context.parent_name,
      });
      return rendered;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logWarn("Failed to load Realtime prompt template, falling back", {
      templatePath,
      error: message,
    });
  }

  const envPrompt = process.env.OPENAI_REALTIME_SYSTEM_PROMPT?.trim();
  if (envPrompt && envPrompt.length > 0) {
    return envPrompt;
  }

  return DEFAULT_PROMPT_FALLBACK;
}
