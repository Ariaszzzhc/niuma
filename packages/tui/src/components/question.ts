// ===========================================================================
// @niuma/tui — structured question input surface
// ---------------------------------------------------------------------------
// The question tool travels through the approval transport, but it is not a
// permission decision. It gets its own bottom surface with suggested answers
// and a separate editor state, so opening a question never destroys the user's
// main draft. Enter submits the typed answer when present, otherwise the
// selected suggestion; esc declines.
// ===========================================================================

import {
  type Color,
  type Cursor,
  type InputEvent,
  renderBlock,
  selectionWindow,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
  wrapText,
} from "@niuma/tuikit";
import {
  createEditorState,
  editorIsEmpty,
  editorReducer,
  type EditorState,
  editorText,
  renderEditorSurface,
} from "./editor.ts";
import { SELECTION_MARKER } from "../symbols.ts";

export interface QuestionState {
  readonly approvalId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly selection: number;
  readonly answer: EditorState;
}

export type QuestionAction =
  | { readonly type: "answer"; readonly feedback: string }
  | { readonly type: "reject"; readonly feedback: string };

export interface QuestionTheme {
  readonly border: Color;
  readonly accent: Color;
  readonly text: Color;
  readonly muted: Color;
  readonly placeholder: Color;
}

export interface QuestionSurface {
  readonly lines: readonly StyledLine[];
  readonly cursor?: Cursor;
}

interface ParsedQuestion {
  readonly question: string;
  readonly options: readonly string[];
}

export const parseQuestionInput = (input: unknown): ParsedQuestion | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  if (typeof value.question !== "string" || value.question.trim() === "") {
    return null;
  }
  const options = Array.isArray(value.options)
    ? value.options.filter((option): option is string =>
      typeof option === "string" && option.trim() !== ""
    )
    : [];
  return { question: value.question, options };
};

export const createQuestionState = (
  approvalId: string,
  input: unknown,
): QuestionState | null => {
  const parsed = parseQuestionInput(input);
  if (parsed === null) return null;
  return {
    approvalId,
    question: parsed.question,
    options: parsed.options,
    selection: 0,
    answer: createEditorState("Type another answer…"),
  };
};

const move = (
  state: QuestionState,
  delta: number,
): QuestionState => {
  if (state.options.length === 0) return state;
  return {
    ...state,
    selection: (state.selection + delta + state.options.length) %
      state.options.length,
  };
};

export const questionReducer = (
  state: QuestionState,
  event: InputEvent,
): readonly [QuestionState, QuestionAction?] => {
  if (event.kind === "esc") {
    return [state, { type: "reject", feedback: "dismissed" }];
  }

  if (event.kind === "key") {
    if (event.key === "up") return [move(state, -1)];
    if (event.key === "down" || event.key === "tab") return [move(state, 1)];
    if (
      event.key === "enter" &&
      !event.mods.shift && !event.mods.ctrl && !event.mods.alt
    ) {
      const typed = editorText(state.answer).trim();
      if (typed !== "") {
        return [state, { type: "answer", feedback: typed }];
      }
      const selected = state.options[state.selection];
      return selected === undefined
        ? [state]
        : [state, { type: "answer", feedback: selected }];
    }
  }

  const [answer] = editorReducer(state.answer, event);
  return [{ ...state, answer }];
};

const HBAR = "─";
const T_LEFT = "├";
const T_RIGHT = "┤";

const divider = (
  width: number,
  label: string,
  theme: QuestionTheme,
): StyledLine => {
  const budget = Math.max(0, width - 2);
  const shown = truncateToWidth(` ${label} `, budget);
  return {
    spans: [
      { text: T_LEFT, style: { fg: theme.border } },
      { text: shown, style: { fg: theme.muted, dim: true } },
      {
        text: HBAR.repeat(Math.max(0, budget - stringWidth(shown))),
        style: { fg: theme.border },
      },
      { text: T_RIGHT, style: { fg: theme.border } },
    ],
  };
};

export const renderQuestionPanel = (
  state: QuestionState,
  width: number,
  theme: QuestionTheme,
  maxQuestionRows = 4,
  maxOptions = 5,
  maxAnswerRows = 3,
): QuestionSurface => {
  const boxW = Math.max(8, width);
  const innerW = Math.max(1, boxW - 4);
  const allQuestionLines = wrapText(state.question, innerW, {
    fg: theme.text,
    bold: true,
  });
  const questionLines = allQuestionLines.slice(
    0,
    Math.max(1, maxQuestionRows),
  );
  if (allQuestionLines.length > questionLines.length) {
    questionLines[questionLines.length - 1] = {
      spans: [{ text: "…", style: { fg: theme.text, bold: true } }],
    };
  }
  const window = selectionWindow(
    { selected: state.selection },
    state.options.length,
    Math.max(1, maxOptions),
  );
  const optionLines: StyledLine[] = state.options
    .slice(window.start, window.end)
    .map((option, index) => {
      const absolute = window.start + index;
      const selected = absolute === window.selected &&
        editorIsEmpty(state.answer);
      const marker = selected ? `${SELECTION_MARKER} ` : "  ";
      const number = `${absolute + 1}. `;
      return {
        spans: [
          {
            text: marker,
            style: {
              fg: selected ? theme.accent : theme.muted,
              bold: selected,
            },
          },
          {
            text: number,
            style: { fg: theme.muted, dim: !selected },
          },
          {
            text: truncateToWidth(
              option,
              Math.max(
                0,
                innerW - stringWidth(marker) - stringWidth(number),
              ),
            ),
            style: {
              fg: selected ? theme.accent : theme.text,
              bold: selected,
            },
          },
        ] satisfies StyledSpan[],
      };
    });

  const body: StyledLine[] = [
    ...questionLines,
    ...(optionLines.length > 0
      ? [
        { spans: [] } satisfies StyledLine,
        ...optionLines,
      ]
      : []),
  ];
  const questionBlock = renderBlock(body, {
    width: boxW,
    title: "question",
    borderColor: theme.border,
    titleStyle: { fg: theme.accent, bold: true },
    paddingX: 1,
  });

  const answerSurface = renderEditorSurface(
    state.answer,
    boxW,
    true,
    {
      border: theme.border,
      borderFocused: theme.accent,
      accent: theme.accent,
      text: theme.text,
      placeholder: theme.placeholder,
    },
    maxAnswerRows,
  );

  // Join both boxes into one continuous panel: replace the touching borders
  // with a labelled divider.
  const head = questionBlock.slice(0, -1);
  const lines = [
    ...head,
    divider(boxW, "answer", theme),
    ...answerSurface.lines.slice(1),
  ];
  const cursor = answerSurface.cursor === undefined ? undefined : {
    ...answerSurface.cursor,
    row: head.length + answerSurface.cursor.row,
  };
  return cursor === undefined ? { lines } : { lines, cursor };
};
