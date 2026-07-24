import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";

// deno-lint-ignore no-slow-types
const QuestionInput_ = z.object({
  question: z.string().min(1).describe("Question to surface to the user."),
  options: z.array(z.string()).optional()
    .describe("Suggested options; the user may also type a free-text answer."),
});

export type QuestionInput = z.infer<typeof QuestionInput_>;
export const QuestionInput: z.ZodType<QuestionInput> = QuestionInput_;

export const questionTool: Tool<QuestionInput> = {
  name: "question",
  def: {
    name: "question",
    description:
      "Ask the user a question. The approval prompter presents the options (if any) and accepts a free-text reply. Use to disambiguate intent.",
    parameters: zodToJsonSchema(QuestionInput),
  },
  accesses: {},
  inputSchema: QuestionInput,
  normalize: (i) => i.question,
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `question:${ctx.sessionId}`;
    const detail = input.options?.length
      ? `${input.question}\n\nOptions:\n${
        input.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
      }`
      : input.question;
    const reply = await ctx.ask({
      callId,
      name: "question",
      summary: "ask user",
      pattern: input.question,
      sensitive: false,
      detail,
    });
    if (reply.decision === "reject") {
      return await toolOutput(
        `error: ${reply.feedback ?? "user declined to answer"}`,
        callId,
        { isError: true },
      );
    }
    // The frontend forwards the free-text answer in `feedback`; when no
    // options were provided the prompter echoes it in `feedback` for `once`.
    return await toolOutput(reply.feedback ?? "(no answer)", callId);
  },
};
