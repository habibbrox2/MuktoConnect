import * as vscode from 'vscode';
import type { OpenAIMessage, OpenAIToolDefinition } from './openai';

function textOf(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (typeof part === 'string') {
    return part;
  }
  return '';
}

function resultContentToString(content: readonly unknown[]): string {
  const pieces: string[] = [];
  for (const part of content) {
    const text = textOf(part);
    if (text) {
      pieces.push(text);
      continue;
    }
    if (part === undefined || part === null) {
      continue;
    }
    try {
      pieces.push(JSON.stringify(part));
    } catch {
      pieces.push(String(part));
    }
  }
  return pieces.join('\n');
}

/**
 * Convert VS Code chat messages into OpenAI chat-completions messages.
 *
 * - user/assistant text parts are merged per message
 * - assistant tool calls become `assistant` messages carrying `tool_calls`
 * - tool results become standalone `role: "tool"` messages (OpenAI requires
 *   them as their own messages, while VS Code nests them in user messages)
 */
export function toOpenAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    const role: OpenAIMessage['role'] =
      message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    let text = '';
    const toolCalls: OpenAIMessage['tool_calls'] = [];

    const flushText = (): void => {
      if (text.length > 0) {
        out.push({ role, content: text });
        text = '';
      }
    };

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        flushText();
        out.push({ role: 'tool', content: resultContentToString(part.content), tool_call_id: part.callId });
        continue;
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        flushText();
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
        continue;
      }
      const textPart = textOf(part);
      if (textPart) {
        text += textPart;
      }
    }

    if (toolCalls.length > 0) {
      if (text.length > 0) {
        out.push({ role, content: text, tool_calls: toolCalls });
      } else {
        out.push({ role, content: null, tool_calls: toolCalls });
      }
    } else {
      flushText();
    }
  }

  return out;
}

export function toOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAIToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? (tool.inputSchema as object)
          : { type: 'object', properties: {} },
    },
  }));
}
