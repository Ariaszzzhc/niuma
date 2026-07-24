// ===========================================================================
// @niuma/tuikit — demo app (proves the whole stack end to end)
// ---------------------------------------------------------------------------
// Run with:
//   deno run --allow-all packages/tuikit/src/demo.ts
//
// Exercises: gradient banner text, a rounded-border box (hand-rolled here
// with StyledLines — layout helpers land in the @niuma/tui app package later),
// a braille spinner animated via `tick()`, and "q" / ESC to quit. Everything
// below is plain TS composing the public tuikit primitives; no Rust is called
// directly.
//
// Requires the native cdylib to be built
//   (cd packages/tuikit/native && cargo build --release);
// otherwise Terminal.open -> KeyParser.create fails fast with a build hint.
// ===========================================================================

import type {
  Color,
  StyledLine,
  StyledSpan,
  TerminalCaps,
} from "./binding_contract.ts";
import { gradient } from "./style.ts";
import { type LoopMsg, type Program, run, tick } from "./loop.ts";
import { stringWidth } from "./width.ts";
import { Terminal, type TerminalSize } from "./terminal.ts";

// Braille spinner frames (each is display width 1).
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// Palette (truecolor endpoints; quantisation to the terminal's depth is the
// native side's job, selected via `caps`).
const PINK: readonly [number, number, number] = [255, 95, 200];
const CYAN: readonly [number, number, number] = [90, 210, 255];
const BORDER: Color = { rgb: [120, 180, 255] };
const DIM_FG: Color = { rgb: [150, 150, 170] };
const SPINNER_FG: Color = { rgb: [255, 120, 220] };
const BANNER = "niuma tuikit";
// The fixed text after the spinner in the box's middle row.
const LABEL_REST = "  niuma — press q to quit";

interface DemoModel {
  readonly n: number; // tick counter (drives the spinner)
  readonly cols: number;
  readonly rows: number;
  readonly quit: boolean;
}

/** A full-width blank line (clears leftover cells when repainting). */
const blankLine = (cols: number): StyledLine => ({
  spans: [{ text: " ".repeat(cols), style: {} }],
});

/**
 * Build the demo view: top whitespace, a centred gradient banner, a centred
 * rounded box with the live spinner + "press q to quit", padded to `rows`.
 */
const view = (model: DemoModel, caps: TerminalCaps): StyledLine[] => {
  const { cols, rows, n } = model;
  const lines: StyledLine[] = [];

  const topPad = Math.max(0, Math.floor(rows / 2) - 4);
  for (let i = 0; i < topPad; i++) lines.push(blankLine(cols));

  // -- gradient banner, centred -------------------------------------------
  const bannerSpans: StyledSpan[] = gradient(
    PINK,
    CYAN,
    BANNER,
    { bold: true },
    caps,
  );
  const bannerW = stringWidth(BANNER);
  const lead = Math.max(0, Math.floor((cols - bannerW) / 2));
  lines.push({
    spans: [{ text: " ".repeat(lead), style: {} }, ...bannerSpans],
  });
  lines.push(blankLine(cols));

  // -- rounded-border box, centred ----------------------------------------
  const boxW = Math.min(
    42,
    Math.max(LABEL_REST.length + 4, cols < 24 ? 20 : cols - 4),
  );
  const innerW = Math.max(1, boxW - 2);
  const boxX = Math.max(0, Math.floor((cols - boxW) / 2));

  const spinner = SPINNER[n % SPINNER.length];
  const labelW = 1 /* spinner */ + LABEL_REST.length; // spinner is width 1
  const innerLead = labelW < innerW ? Math.floor((innerW - labelW) / 2) : 0;
  const trailing = Math.max(0, innerW - innerLead - labelW);

  const boxLine = (edge: string): StyledSpan[] => [
    { text: " ".repeat(boxX), style: {} },
    { text: edge, style: { fg: BORDER } },
  ];

  const top = boxLine(`┌${"─".repeat(innerW)}┐`);
  const middle: StyledSpan[] = [
    { text: " ".repeat(boxX), style: {} },
    { text: "│", style: { fg: BORDER } },
    { text: " ".repeat(innerLead), style: {} },
    { text: spinner, style: { fg: SPINNER_FG } },
    { text: LABEL_REST, style: { fg: DIM_FG } },
    { text: " ".repeat(trailing), style: {} },
    { text: "│", style: { fg: BORDER } },
  ];
  const bottom = boxLine(`└${"─".repeat(innerW)}┘`);

  lines.push({ spans: top });
  lines.push({ spans: middle });
  lines.push({ spans: bottom });

  // pad the remainder so stale cells below get blanked on repaint
  while (lines.length < rows) lines.push(blankLine(cols));
  return lines;
};

/** Build the demo program bound to the detected `caps` and starting `size`. */
const makeProgram = (
  caps: TerminalCaps,
  size: TerminalSize,
): Program<DemoModel, LoopMsg> => ({
  init: () => [
    { n: 0, cols: size.cols, rows: size.rows, quit: false },
  ],

  // One spinner tick every 80ms for the lifetime of the run.
  subscriptions: () => [tick(80, (n) => ({ type: "tuikit:tick" as const, n }))],

  update: (model, msg) => {
    switch (msg.type) {
      case "tuikit:tick":
        return [{ ...model, n: msg.n }];
      case "tuikit:resize":
        return [{ ...model, cols: msg.size.cols, rows: msg.size.rows }];
      case "tuikit:key": {
        const ev = msg.event;
        if (ev.kind === "esc") return [{ ...model, quit: true }];
        if (ev.kind === "text" && (ev.text === "q" || ev.text === "Q")) {
          return [{ ...model, quit: true }];
        }
        return [model];
      }
      case "tuikit:error":
        // Cmd failures are surfaced but never fatal to the demo.
        return [model];
    }
  },

  shouldQuit: (model) => model.quit,

  view: (model) => view(model, caps),
});

const main = async (): Promise<void> => {
  const term = Terminal.open();
  try {
    await run(term, makeProgram(term.caps, term.size));
  } finally {
    term.dispose();
  }
};

// Entry point: run, and surface a clean diagnostic on any fault.
await main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
