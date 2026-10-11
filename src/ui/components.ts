/**
 * Modern UI component toolkit for Selora CLI.
 *
 * Implements:
 * 1. Rounded Unicode Box Builder (`renderBox`):
 *    - Rounded, single, double, dim, and hairline border styles.
 *    - Exact character width calculations via `string-width` (immune to ANSI escape misalignment).
 *    - Title embedding in top border (`╭─ Title ───╮`), customizable padding, minWidth.
 * 2. Kinetic Step Indicators (`step`, `renderStep`, `renderSteps`):
 *    - Multi-step status formatter: done (✔), running (⏳ / spinner frame),
 *      failed (✖), pending (✦ / ·).
 * 3. Badges & Accents (`renderBadge`):
 *    - High-visibility pill and bracket status tags (`[ active ]`, `( active )`).
 * 4. Clean Aligned Table Formatter (`renderTable`):
 *    - Column-aligned tabular data with clean headers and subtle dividers.
 * 5. Modern Key-Value Card Formatter (`renderCard`):
 *    - Aligned key-value pairs with optional header, footer, and box framing.
 *
 * All components strictly respect Theme (NO_COLOR / mono theme / level 0).
 */

import stringWidth from 'string-width';
import { themeFor, type Theme } from './theme.js';

// ---------------------------------------------------------------------------
// Default Theme Helper
// ---------------------------------------------------------------------------

export function getDefaultTheme(): Theme {
  return themeFor(undefined, process.stdout.isTTY === true);
}

// ============================================================================
// 1. Unicode Box Builder
// ============================================================================

export type BoxBorderStyle = 'rounded' | 'single' | 'double' | 'dim' | 'hairline';

export interface BorderChars {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

export const BORDER_STYLES: Record<BoxBorderStyle, BorderChars> = {
  rounded: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
  single: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
  },
  double: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
  },
  dim: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
  hairline: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
  },
};

export interface RenderBoxOptions {
  title?: string | undefined;
  content: string | string[];
  borderColor?: string | undefined;
  borderStyle?: BoxBorderStyle | BorderChars | undefined;
  padding?: number | undefined;
  paddingY?: number | undefined;
  minWidth?: number | undefined;
  theme?: Theme | undefined;
}

function resolveBorderChars(style: BoxBorderStyle | BorderChars | undefined): BorderChars {
  if (typeof style === 'object' && style !== null) {
    return style;
  }
  if (typeof style === 'string' && style in BORDER_STYLES) {
    return BORDER_STYLES[style];
  }
  return BORDER_STYLES.rounded;
}

function colorizeBorder(
  text: string,
  borderColor: string | undefined,
  borderStyle: BoxBorderStyle | BorderChars | undefined,
  theme: Theme,
): string {
  if (theme.level === 0 || text === '') return text;

  if (borderColor !== undefined && borderColor !== '') {
    if (borderColor.startsWith('#')) {
      return theme.wrap(borderColor, text);
    }
    if (borderColor === 'dim' || borderColor === 'space') {
      return theme.dim(text);
    }
    if (borderColor === 'cyan') return theme.cyan(text);
    if (borderColor === 'violet') return theme.violet(text);
    if (borderColor === 'indigo') return theme.indigo(text);
    if (borderColor === 'magenta') return theme.magenta(text);
    if (borderColor === 'success') return theme.success(text);
    if (borderColor === 'warning') return theme.warning(text);
    if (borderColor === 'error') return theme.error(text);
    if (borderColor === 'star') return theme.star(text);

    const hex = (theme.palette as unknown as Record<string, string>)[borderColor];
    if (hex !== undefined) {
      return theme.wrap(hex, text);
    }
    return theme.wrap(borderColor, text);
  }

  // If no borderColor was explicitly set: dim / hairline styles use dim space gray.
  // Rounded / single / double default to subtle dim space gray as well.
  if (borderStyle === 'dim' || borderStyle === 'hairline') {
    return theme.dim(text);
  }
  return theme.dim(text);
}

export function renderBox(options: RenderBoxOptions): string {
  const theme = options.theme ?? getDefaultTheme();
  const borderChars = resolveBorderChars(options.borderStyle);
  const paddingX = Math.max(0, options.padding ?? 1);
  const paddingY = Math.max(0, options.paddingY ?? 0);
  const minWidth = Math.max(0, options.minWidth ?? 0);

  // Normalize content into an array of lines, handling internal \n / \r\n
  const rawContent = Array.isArray(options.content) ? options.content : [options.content];
  const contentLines: string[] = rawContent.flatMap((item) => String(item).split(/\r?\n/));

  // Measure content line widths using stringWidth to account for wide chars and strip ANSI
  const maxContentWidth = contentLines.reduce((max, line) => Math.max(max, stringWidth(line)), 0);

  const title = options.title?.trim();
  const hasTitle = title !== undefined && title.length > 0;
  const titleWidth = hasTitle ? stringWidth(title) : 0;

  // Box total width = innerWidth + 2 (left border character + right border character)
  const minInner = Math.max(0, minWidth - 2);
  const requiredContentInner = maxContentWidth + paddingX * 2;
  // With title, top line inner segment is: horizontal (1) + space (1) + title (titleWidth) + space (1) + horizontal (>=1)
  const requiredTitleInner = hasTitle ? titleWidth + 4 : 0;

  const innerWidth = Math.max(minInner, requiredContentInner, requiredTitleInner);

  const color = (s: string) => colorizeBorder(s, options.borderColor, options.borderStyle, theme);

  // Top line
  let topLine: string;
  if (hasTitle) {
    const trailingDashesCount = Math.max(1, innerWidth - (titleWidth + 3));
    const formattedTitle = title.includes('\x1b[')
      ? title
      : theme.level > 0
        ? theme.bold(theme.star(title))
        : title;
    topLine =
      color(borderChars.topLeft + borderChars.horizontal + ' ') +
      formattedTitle +
      color(' ' + borderChars.horizontal.repeat(trailingDashesCount) + borderChars.topRight);
  } else {
    topLine = color(
      borderChars.topLeft + borderChars.horizontal.repeat(innerWidth) + borderChars.topRight,
    );
  }

  // Bottom line
  const bottomLine = color(
    borderChars.bottomLeft + borderChars.horizontal.repeat(innerWidth) + borderChars.bottomRight,
  );

  // Content rows
  const leftPad = ' '.repeat(paddingX);
  const contentRows: string[] = [];

  // Optional vertical padding top
  for (let i = 0; i < paddingY; i += 1) {
    contentRows.push(
      color(borderChars.vertical) + ' '.repeat(innerWidth) + color(borderChars.vertical),
    );
  }

  for (const line of contentLines) {
    const lineW = stringWidth(line);
    const rightPadSpaces = Math.max(0, innerWidth - paddingX * 2 - lineW);
    const rightPad = ' '.repeat(rightPadSpaces + paddingX);
    contentRows.push(
      color(borderChars.vertical) + leftPad + line + rightPad + color(borderChars.vertical),
    );
  }

  // Optional vertical padding bottom
  for (let i = 0; i < paddingY; i += 1) {
    contentRows.push(
      color(borderChars.vertical) + ' '.repeat(innerWidth) + color(borderChars.vertical),
    );
  }

  return [topLine, ...contentRows, bottomLine].join('\n');
}

// ============================================================================
// 2. Kinetic Step Indicators
// ============================================================================

export type StepStatus = 'done' | 'running' | 'failed' | 'pending';

export interface StepOptions {
  status: StepStatus;
  label: string;
  detail?: string | undefined;
  spinnerFrame?: string | undefined;
  pendingChar?: '✦' | '·' | string | undefined;
  theme?: Theme | undefined;
}

export interface StepItem {
  status: StepStatus;
  label: string;
  detail?: string | undefined;
}

export const STEP_COLORS: Record<StepStatus, string> = {
  done: '#34d399', // Mint green
  running: '#22d3ee', // Electric cyan
  failed: '#fb7185', // Coral red
  pending: '#6b7280', // Slate gray
};

export const STEP_ICONS: Record<StepStatus, string> = {
  done: '✔',
  running: '⏳',
  failed: '✖',
  pending: '✦',
};

export function step(
  statusOrOptions: StepStatus | StepOptions,
  labelOrTheme?: string | Theme,
  detail?: string,
  maybeTheme?: Theme,
): string {
  let status: StepStatus;
  let label: string;
  let detailText: string | undefined = detail;
  let theme: Theme | undefined = maybeTheme;
  let spinnerFrame: string | undefined;
  let pendingChar: string | undefined;

  if (typeof statusOrOptions === 'object' && statusOrOptions !== null) {
    status = statusOrOptions.status;
    label = statusOrOptions.label;
    detailText = statusOrOptions.detail;
    theme = statusOrOptions.theme;
    spinnerFrame = statusOrOptions.spinnerFrame;
    pendingChar = statusOrOptions.pendingChar;
  } else {
    status = statusOrOptions;
    label = typeof labelOrTheme === 'string' ? labelOrTheme : '';
    if (typeof labelOrTheme === 'object') {
      theme = labelOrTheme as Theme;
    }
  }

  const activeTheme = theme ?? getDefaultTheme();

  let rawIcon: string;
  if (status === 'running') {
    rawIcon = spinnerFrame ?? STEP_ICONS.running;
  } else if (status === 'pending') {
    rawIcon = pendingChar ?? STEP_ICONS.pending;
  } else {
    rawIcon = STEP_ICONS[status];
  }

  const colorHex = STEP_COLORS[status];
  const icon = activeTheme.wrap(colorHex, rawIcon);

  let formattedDetail = '';
  if (detailText !== undefined && detailText !== '') {
    formattedDetail = ' ' + activeTheme.dim(detailText);
  }

  return `${icon} ${label}${formattedDetail}`;
}

export const renderStep = step;

export function renderSteps(steps: StepItem[], theme?: Theme): string {
  return steps.map((s) => step(s.status, s.label, s.detail, theme)).join('\n');
}

// ============================================================================
// 3. Badges & Accents
// ============================================================================

export type BadgeColor = 'violet' | 'cyan' | 'success' | 'warning' | 'error' | 'dim';
export type BadgeStyle = 'bracket' | 'pill' | 'outline' | 'filled';

export interface BadgeOptions {
  style?: BadgeStyle | undefined;
  bold?: boolean | undefined;
  dimBrackets?: boolean | undefined;
  compact?: boolean | undefined;
  theme?: Theme | undefined;
}

export interface RenderBadgeOptions extends BadgeOptions {
  text: string;
  color?: BadgeColor | undefined;
}

function badgeHexFor(theme: Theme, color: BadgeColor): string {
  switch (color) {
    case 'violet':
      return theme.palette.violet;
    case 'cyan':
      return theme.palette.cyan;
    case 'success':
      return theme.palette.success;
    case 'warning':
      return theme.palette.warning;
    case 'error':
      return theme.palette.error;
    case 'dim':
      return theme.palette.space;
  }
}

export function renderBadge(
  textOrOptions: string | RenderBadgeOptions,
  color?: BadgeColor,
  options?: BadgeOptions,
): string {
  let text: string;
  let badgeColor: BadgeColor = color ?? 'cyan';
  let opts: BadgeOptions = options ?? {};

  if (typeof textOrOptions === 'object' && textOrOptions !== null) {
    text = textOrOptions.text;
    badgeColor = textOrOptions.color ?? color ?? 'cyan';
    opts = textOrOptions;
  } else {
    text = textOrOptions;
  }

  const theme = opts.theme ?? getDefaultTheme();
  const hex = badgeHexFor(theme, badgeColor);
  const style = opts.style ?? 'bracket';
  const compact = opts.compact === true;
  const bold = opts.bold ?? true;
  const dimBrackets = opts.dimBrackets === true;

  const leftChar = style === 'pill' ? '(' : '[';
  const rightChar = style === 'pill' ? ')' : ']';
  const spacing = compact ? '' : ' ';

  if (theme.level === 0) {
    return `${leftChar}${spacing}${text}${spacing}${rightChar}`;
  }

  if (dimBrackets) {
    const styledLeft = theme.dim(leftChar);
    const styledRight = theme.dim(rightChar);
    const styledText = theme.wrap(hex, text, { bold });
    return `${styledLeft}${spacing}${styledText}${spacing}${styledRight}`;
  }

  const raw = `${leftChar}${spacing}${text}${spacing}${rightChar}`;
  return theme.wrap(hex, raw, { bold });
}

// ============================================================================
// 4. Clean Aligned Table Formatter
// ============================================================================

export interface TableColumn {
  header: string;
  width?: number | undefined;
  align?: 'left' | 'right' | undefined;
}

export interface RenderTableOptions {
  columns: TableColumn[];
  rows: (string | number)[][];
  theme?: Theme | undefined;
  gap?: number | undefined;
}

export function renderTable(options: RenderTableOptions): string {
  const { columns, rows } = options;
  if (columns.length === 0) return '';

  const theme = options.theme ?? getDefaultTheme();
  const gapSize = Math.max(1, options.gap ?? 2);
  const gap = ' '.repeat(gapSize);

  // Calculate width for each column
  const colWidths = columns.map((col, i) => {
    if (col.width !== undefined && col.width > 0) {
      return col.width;
    }
    const headerW = stringWidth(col.header);
    let maxRowW = 0;
    for (const row of rows) {
      const val = row[i];
      if (val !== undefined && val !== null) {
        const w = stringWidth(String(val));
        if (w > maxRowW) maxRowW = w;
      }
    }
    return Math.max(1, headerW, maxRowW);
  });

  function alignCell(content: string, width: number, align: 'left' | 'right' = 'left'): string {
    const w = stringWidth(content);
    if (w >= width) return content;
    const padding = ' '.repeat(width - w);
    return align === 'right' ? padding + content : content + padding;
  }

  // Header line
  const headerCells = columns.map((col, i) => {
    const colW = colWidths[i]!;
    const align = col.align ?? 'left';
    const alignedHeader = alignCell(col.header, colW, align);
    if (theme.level === 0) return alignedHeader;
    return theme.bold(theme.star(alignedHeader));
  });
  const headerLine = headerCells.join(gap);

  // Subtle divider line (dim dashes)
  const dividerCells = columns.map((_col, i) => {
    const colW = colWidths[i]!;
    const dashes = '─'.repeat(colW);
    return theme.dim(dashes);
  });
  const dividerLine = dividerCells.join(gap);

  // Data rows
  const rowLines = rows.map((row) => {
    const cells = columns.map((col, i) => {
      const colW = colWidths[i]!;
      const align = col.align ?? 'left';
      const rawVal = row[i];
      const cellText = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';
      return alignCell(cellText, colW, align);
    });
    return cells.join(gap);
  });

  return [headerLine, dividerLine, ...rowLines].join('\n');
}

// ============================================================================
// 5. Modern Key-Value Card Formatter
// ============================================================================

export interface RenderCardOptions {
  title?: string | undefined;
  fields: [string, string][];
  footer?: string | undefined;
  borderColor?: string | undefined;
  borderStyle?: BoxBorderStyle | BorderChars | undefined;
  padding?: number | undefined;
  minWidth?: number | undefined;
  theme?: Theme | undefined;
}

export function renderCard(options: RenderCardOptions): string {
  const theme = options.theme ?? getDefaultTheme();
  const { fields, title, footer } = options;

  // Measure key widths to align columns cleanly
  const maxKeyWidth = fields.reduce((max, [key]) => Math.max(max, stringWidth(key)), 0);

  const lines: string[] = [];

  for (const [key, value] of fields) {
    const keyW = stringWidth(key);
    const keyPad = ' '.repeat(Math.max(0, maxKeyWidth - keyW));
    if (theme.level === 0) {
      lines.push(`${key}${keyPad}  ${value}`);
    } else {
      const styledKey = theme.dim(key);
      const styledValue = value.includes('\x1b[') ? value : theme.star(value);
      lines.push(`${styledKey}${keyPad}  ${styledValue}`);
    }
  }

  if (footer !== undefined && footer.trim().length > 0) {
    if (lines.length > 0) {
      const contentWidths = lines.map((l) => stringWidth(l));
      const footerWidth = stringWidth(footer);
      const dividerWidth = Math.max(10, ...contentWidths, footerWidth);
      lines.push(theme.dim('─'.repeat(dividerWidth)));
    }
    const styledFooter = theme.level > 0 && !footer.includes('\x1b[') ? theme.dim(footer) : footer;
    lines.push(styledFooter);
  }

  return renderBox({
    title,
    content: lines,
    borderColor: options.borderColor,
    borderStyle: options.borderStyle,
    padding: options.padding ?? 1,
    minWidth: options.minWidth,
    theme,
  });
}
