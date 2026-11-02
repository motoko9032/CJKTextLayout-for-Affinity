// Affinity CJK Typography Toolkit
// Version: 0.5.6
// Purpose: configurable CJK typography audit and optional Yakumono compression.
// Target: Affinity by Canva desktop scripting API (SDK 3.3.x)
// License: MIT
//
// 0.5.0 fixes:
// - read StoryRange text through getText when available, with validated fallbacks
// - keep UTF-16 offsets correct for supplementary characters in line-head checks
// - support newer CJK ideograph extensions and avoid quadratic paragraph lookups
// - prevent overlapping kerning options from exceeding the supported adjustment range
//
// 0.5.1 fixes:
// - tolerate Affinity StoryRanges that include a trailing non-text boundary
// - include actual range and text lengths in unrecoverable range errors
//
// 0.5.2 fixes:
// - cap node formatting ranges at the readable Story text boundary
// - recognize repeated paragraph-opening dialogue quotes as continuations
// - reject out-of-bounds formatting targets before building the compound command
//
// 0.5.3 fixes:
// - pass SDK StoryRange instances to TextSelection instead of plain objects
// - report failed formatting commands as failures, not successful zero-count edits
//
// 0.5.4 fixes:
// - remove line-head punctuation adjustments
// - exempt ellipses and Han ideographs from consecutive-punctuation compression
//
// 0.5.5 fixes:
// - add an opt-in reset for CharacterSpacing and ManualKerning in selected text ranges
//
// 0.5.6 fixes:
// - exempt dash punctuation from consecutive-punctuation compression

// 0.4.7 fixes:
// - build formatting candidates from Story.text and the node's StoryRange
// - exclude full-width punctuation from CJK/Latin adjacency checks

// 0.4.6 fixed:
// - preserve CJK/Latin spacing when node-local StoryRange reads are unavailable

// 0.4.5 fixed:
// - always show the typography options dialog, including when candidate detection fails
// - isolate errors between candidate detectors

// 0.4.4 fixed:
// - read text using each node's absolute StoryRange before building formatting targets

// 0.4.3 added:
// - recognize full-width CJK punctuation without relying on Unicode property escapes
// - show matched punctuation samples in the adjustment dialog

// 0.4.2 added:
// - clearer guidance when no adjacent punctuation pairs are found
//
// 0.4.1 fixed:
// - compress consecutive punctuation with pair kerning instead of character tracking
//
// 0.4.0 added:
// - actual line-head punctuation compression using rendered glyph outlines
// - compression of consecutive punctuation runs
//
// 0.3.0 added:
// - optional, undoable character-spacing adjustment at CJK/Latin boundaries
// - supplementary-plane CJK recognition without losing UTF-16 offsets
//
// 0.2.0 added:
// - rule profiles (Simplified Chinese, Traditional Chinese, Japanese)
// - exact UTF-16 string offsets and paragraph numbers
// - better bracket pairing (including nesting/order)
// - clearer separation of policy-dependent spacing from likely errors
// - safer per-story error handling

'use strict';

const { Document } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { UnitType } = require('/units.js');
const { GlyphAttDoubleType } = require('/glyphatts.js');
const { Selection, TextSelection } = require('/selections.js');
const { StoryDelta } = require('/storydelta.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { StoryRange } = require('affinity:story');

const VERSION = '0.5.6';

// Edit these settings before running, or use one of the presets below.
const CONFIG = {
  profile: 'zh-CN',              // 'zh-CN' | 'zh-TW' | 'ja-JP' | 'custom'
  maxExamplesPerCategory: 10,
  scanLinkedStoryOnce: true,

  // 'review': report CJK/Latin spaces as editorial choices
  // 'ignore': do not report a single CJK/Latin space
  // 'strict-no-space': report single spaces between CJK and Latin/digits
  cjkLatinSpacePolicy: 'review',

  // 'review': report CJK/Latin adjacency for optical inspection
  // 'ignore': suppress these hints
  cjkLatinAdjacency: 'review',

  checkAsciiPunctuation: true,
  checkRepeatedPunctuation: true,
  checkBracketPairs: true,
  checkParagraphBoundaries: true,
  checkRepeatedSpaces: true,
};

const PROFILES = {
  'zh-CN': {
    label: '简体中文（大陆）',
    punctuationHint: '中文语境通常优先使用全角中文标点；英文、代码和专名内部按原文处理',
  },
  'zh-TW': {
    label: '繁体中文（台湾）',
    punctuationHint: '中文语境通常优先使用全形中文標點；英文、程式碼和專名内部按原文处理',
  },
  'ja-JP': {
    label: '日本語',
    punctuationHint: '日文语境通常使用「、」「。」等日文标点；英文和代码内部按原文处理',
  },
  custom: {
    label: '自定义',
    punctuationHint: '请按当前文稿的编辑规范判断',
  },
};

const CJK = /[\u2E80-\u2EFF\u2F00-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}]/u;
const HAN_IDEOGRAPH = /[\u3005-\u3007\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}]/u;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;
const ASCII_PUNCT = /[,.;:!?]/;
const PUNCTUATION = new Set(Array.from(
  '！？，。；：、…‥・．，｡､〝〞〟〃々〆〜～ー‐‑‒–—―：；？！·・･「」『』【】〔〕〈〉《》「」〘〙〚〛（）［］｛｝｢｣､｡﹐﹑﹒﹔﹕﹖﹗﹙﹚﹛﹜﹝﹞﹟﹠﹡﹣﹦﹨﹩﹪﹫ﹰﹱﹲﹳﹴ﹵ﹶﹷﹸﹹﹺﹻﹼﹽﹾﹿ,.!?;:()[]{}<>'
));
const DASH_PUNCTUATION = new Set(Array.from('‐‑‒–—―－'));
const OPEN_TO_CLOSE = new Map([
  ['（', '）'], ['「', '」'], ['『', '』'], ['【', '】'],
  ['《', '》'], ['〈', '〉'], ['〔', '〕'], ['〖', '〗'],
  ['〘', '〙'], ['〚', '〛'], ['(', ')'], ['[', ']'], ['{', '}'],
]);
const CLOSE_TO_OPEN = new Map(Array.from(OPEN_TO_CLOSE, ([o, c]) => [c, o]));

const CATEGORY_ORDER = [
  '段首标点', '段末标点', '半角标点', '连续标点',
  '括号配对', '重复空格', '中西文空格', '中西文邻接',
];

function addFinding(findings, category, message, sample, offset, paragraph) {
  if (!findings[category]) findings[category] = [];
  findings[category].push({ message, sample, offset, paragraph });
}

function excerpt(text, index, radius = 16) {
  let start = Math.max(0, index - radius);
  let end = Math.min(text.length, index + radius);
  const startsWithLowSurrogate = start > 0 &&
    text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF &&
    text.charCodeAt(start - 1) >= 0xD800 && text.charCodeAt(start - 1) <= 0xDBFF;
  const endsWithHighSurrogate = end < text.length &&
    text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF &&
    text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF;
  if (startsWithLowSurrogate) start++;
  if (endsWithHighSurrogate) end--;
  return text.slice(start, end)
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '↵')
    .replace(/\t/g, '⇥');
}

function createParagraphLookup(text) {
  const starts = [0];
  const breaks = /\r\n|\r|\n|\u2028|\u2029/g;
  let match;
  while ((match = breaks.exec(text)) !== null) {
    starts.push(match.index + match[0].length);
  }

  return offset => {
    const position = Math.max(0, Math.min(text.length, offset));
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function getStoryText(story) {
  if (typeof story.text === 'string') return story.text;
  if (typeof story.getLength !== 'function' || typeof story.getText !== 'function') {
    throw new Error('Story 未返回可读取的文本字符串。');
  }

  const length = story.getLength();
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('Story 未返回有效的文本长度。');
  }
  const text = story.getText(0, length);
  if (typeof text !== 'string' || text.length !== length) {
    throw new Error('Story 未返回与文本长度匹配的字符串。');
  }
  return text;
}

function isCjk(ch) {
  return !!ch && CJK.test(ch) && !PUNCTUATION.has(ch);
}

function isLatinOrDigit(ch) {
  return !!ch && LATIN_OR_DIGIT.test(ch);
}

function isCompressiblePunctuation(ch) {
  return PUNCTUATION.has(ch) &&
    !HAN_IDEOGRAPH.test(ch) &&
    !DASH_PUNCTUATION.has(ch);
}

function codePoints(text) {
  const points = [];
  for (let offset = 0; offset < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(offset));
    points.push({ ch, offset, length: ch.length });
    offset += ch.length;
  }
  return points;
}

function getNodeStoryText(node) {
  const storyInterface = node.storyInterface;
  const story = storyInterface?.story || node.story;
  const range = storyInterface?.storyRange || node.storyRange;
  const end = range && Number.isInteger(range.end)
    ? range.end
    : range && Number.isInteger(range.begin) && Number.isInteger(range.length)
      ? range.begin + range.length
      : NaN;
  if (!story ||
      !range || !Number.isInteger(range.begin) || !Number.isInteger(end) ||
      range.begin < 0 || end < range.begin) {
    throw new Error('文本对象没有可读取的有效 StoryRange。');
  }

  const rangeLength = end - range.begin;
  let storyText;
  let storyTextError;
  try {
    storyText = getStoryText(story);
  } catch (error) {
    storyTextError = error;
  }
  if (typeof storyText === 'string' &&
      range.begin <= storyText.length && end > storyText.length) {
    return {
      story,
      begin: range.begin,
      end: storyText.length,
      text: storyText.slice(range.begin),
    };
  }

  let rangeReadError;
  let rangeReadLength = null;
  if (typeof story.getText === 'function') {
    try {
      const rangeText = story.getText(range.begin, rangeLength);
      if (typeof rangeText === 'string' && rangeText.length === rangeLength &&
          (typeof storyText !== 'string' || end <= storyText.length)) {
        return {
          story,
          begin: range.begin,
          end,
          text: rangeText,
        };
      }
      if (typeof rangeText === 'string') {
        rangeReadLength = rangeText.length;
        rangeReadError = new Error(
          end > storyText?.length
            ? 'Story.getText 返回范围超出可读 Story 文本长度。'
            : 'Story.getText 返回的文本长度与 StoryRange 不匹配。'
        );
      }
    } catch (error) {
      rangeReadError = error;
    }
  }

  if (typeof storyText !== 'string') {
    if (rangeReadError) {
      throw new Error(
        `Story 文本不可用：${errorMessage(storyTextError)}；` +
        `StoryRange 读取失败：${errorMessage(rangeReadError)}`
      );
    }
    throw storyTextError;
  }

  if (storyText.length >= end) {
    return {
      story,
      begin: range.begin,
      end,
      text: storyText.slice(range.begin, end),
    };
  }
  if (storyText.length === rangeLength) {
    return { story, begin: range.begin, end, text: storyText };
  }
  if (range.begin <= storyText.length && end === storyText.length + 1) {
    return {
      story,
      begin: range.begin,
      end: storyText.length,
      text: storyText.slice(range.begin),
    };
  }
  if (rangeReadError) {
    const actualLength = rangeReadLength === null
      ? '不可用'
      : String(rangeReadLength);
    throw new Error(
      `无法读取 StoryRange 文本：范围 [${range.begin}, ${end}) 长度为 ${rangeLength}，` +
      `Story 文本长度为 ${storyText.length}，Story.getText 返回长度为 ${actualLength}；` +
      `${errorMessage(rangeReadError)}`
    );
  }
  throw new Error(
    `Story 文本长度 ${storyText.length} 与范围 [${range.begin}, ${end}) ` +
    `（长度 ${rangeLength}）不匹配。`
  );
}

function findCjkLatinBoundaries(node, text, nodeRange = getNodeStoryText(node)) {
  const { story, begin } = nodeRange;
  const points = codePoints(text);
  const targets = [];

  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1];
    const right = points[i];

    if ((isCjk(left.ch) && isLatinOrDigit(right.ch)) ||
        (isLatinOrDigit(left.ch) && isCjk(right.ch))) {
      targets.push({
        node,
        story,
        begin: begin + left.offset,
        end: begin + left.offset + left.length,
      });
    }
  }
  return targets;
}

function requestTypographyOptions(counts) {
  const dialog = Dialog.create(`Affinity CJK Typography Toolkit ${VERSION}`);
  dialog.initialWidth = 520;

  const column = dialog.addColumn();
  const spacingGroup = column.addGroup('中西文字距');
  const applySpacing = spacingGroup.addCheckBox(
    `调整 ${counts.cjkLatin} 处中西文直接相邻字距`,
    false
  );
  const spacingAmount = spacingGroup.addUnitValueEditor(
    '字距增量（em）',
    UnitType.Number,
    UnitType.Number,
    0.03,
    -0.5,
    0.5
  );
  spacingAmount.precision = 3;
  applySpacing.isEnabled = counts.cjkLatin > 0;
  spacingAmount.isEnabled = counts.cjkLatin > 0;

  const runGroup = column.addGroup('连续标点挤压');
  const applyRuns = runGroup.addCheckBox(
    `压缩 ${counts.punctuationRuns} 处连续标点间距${counts.punctuationSample ? `（如“${counts.punctuationSample}”）` : ''}`,
    false
  );
  const runAmount = runGroup.addUnitValueEditor(
    '每对标点字偶距增量（em）',
    UnitType.Number,
    UnitType.Number,
    -0.5,
    -1,
    0
  );
  runAmount.precision = 3;
  applyRuns.isEnabled = counts.punctuationRuns > 0;
  runAmount.isEnabled = counts.punctuationRuns > 0;
  runGroup.addStaticText(
    '仅处理紧挨且无空格的标点对（如“！！”“？！”）；空格或换行会分隔标点。'
  );
  const resetGroup = column.addGroup('修复已有字距');
  const resetSpacing = resetGroup.addCheckBox(
    `将 ${counts.resetRanges} 个所选文本范围的字符间距和字偶距归零`,
    false
  );
  resetSpacing.isEnabled = counts.resetRanges > 0;
  resetGroup.addStaticText(
    '会清除所选范围内原有的手工字距；建议先复制文档。'
  );
  if (counts.cjkLatin + counts.punctuationRuns + counts.resetRanges === 0) {
    column.addGroup('扫描状态').addStaticText(
      '当前没有可应用的调整目标；请检查扫描结果中的处理异常。'
    );
  }

  const result = dialog.runModal();
  if (result.value !== DialogResult.Ok.value) return null;
  return {
    applySpacing: applySpacing.value,
    spacingAmount: Number(spacingAmount.value),
    applyRuns: applyRuns.value,
    runAmount: Number(runAmount.value),
    resetSpacing: resetSpacing.value,
  };
}

function findConsecutivePunctuationTargets(node, text, nodeRange = getNodeStoryText(node)) {
  const { story, begin } = nodeRange;
  const points = codePoints(text)
    .map(point => ({ ...point, offset: point.offset + begin }));
  const targets = [];
  for (let i = 0; i + 1 < points.length;) {
    if (!isCompressiblePunctuation(points[i].ch)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < points.length && isCompressiblePunctuation(points[end].ch)) end++;
    if (end - i > 1) {
      const ellipsisIndexes = new Set();
      for (let j = i; j < end; j++) {
        if (points[j].ch === '…' || points[j].ch === '‥') {
          ellipsisIndexes.add(j);
        }
        if (points[j].ch !== '.' && points[j].ch !== '．') continue;
        let periodEnd = j + 1;
        while (periodEnd < end &&
            (points[periodEnd].ch === '.' || points[periodEnd].ch === '．')) {
          periodEnd++;
        }
        if (periodEnd - j >= 3) {
          for (let k = j; k < periodEnd; k++) ellipsisIndexes.add(k);
        }
        j = periodEnd - 1;
      }
      for (let j = i; j < end - 1; j++) {
        if (ellipsisIndexes.has(j) || ellipsisIndexes.has(j + 1)) continue;
        targets.push({
          node,
          story,
          begin: points[j].offset,
          end: points[j].offset + points[j].length,
          sample: `${points[j].ch}${points[j + 1].ch}`,
        });
      }
    }
    i = end;
  }
  return targets;
}

function collectFormattingTargets(targets, lookup, candidates, attribute, amount) {
  for (const candidate of candidates) {
    let storyTargets = lookup.get(candidate.story);
    if (!storyTargets) {
      storyTargets = new Map();
      lookup.set(candidate.story, storyTargets);
    }
    const key = `${candidate.begin}:${candidate.end}:${attribute}`;
    const existing = storyTargets.get(key);
    if (existing) {
      const combinedAmount = existing.amount + amount;
      existing.amount = attribute === GlyphAttDoubleType.ManualKerning
        ? Math.max(-1, Math.min(0, combinedAmount))
        : Math.max(-0.5, Math.min(0.5, combinedAmount));
    } else {
      const target = { ...candidate, attribute, amount };
      targets.push(target);
      storyTargets.set(key, target);
    }
  }
}

function collectResetTargets(targets, ranges) {
  for (const range of ranges) {
    for (const attribute of [
      GlyphAttDoubleType.CharacterSpacing,
      GlyphAttDoubleType.ManualKerning,
    ]) {
      targets.push({ ...range, attribute, value: 0 });
    }
  }
}

function applyTypographyAdjustments(doc, targets, errors) {
  const builder = CompoundCommandBuilder.create();
  const storyLengths = new Map();
  let succeeded = false;
  let resetCommandCount = 0;
  const applied = {
    [GlyphAttDoubleType.CharacterSpacing]: 0,
    [GlyphAttDoubleType.ManualKerning]: 0,
  };

  for (const target of targets) {
    try {
      let storyLength = storyLengths.get(target.story);
      if (storyLength === undefined) {
        storyLength = getStoryText(target.story).length;
        storyLengths.set(target.story, storyLength);
      }
      if (!Number.isInteger(target.begin) || !Number.isInteger(target.end) ||
          target.begin < 0 || target.end <= target.begin || target.end > storyLength) {
        throw new Error(
          `目标范围 [${target.begin}, ${target.end}) 超出 Story 文本长度 ${storyLength}。`
        );
      }

      let value = target.value;
      if (value === undefined) {
        const glyphAtts = target.story.getGlyphAtts(target.begin);
        const current = target.attribute === GlyphAttDoubleType.ManualKerning
          ? glyphAtts.manualKerning
          : glyphAtts.getDoubleValue(target.attribute);
        if (!Number.isFinite(current)) {
          throw new Error('当前字距属性不是有效数值。');
        }
        value = current + target.amount;
      }
      if (!Number.isFinite(value)) {
        throw new Error('目标字距属性不是有效数值。');
      }

      const selection = Selection.create(doc, target.node);
      selection.addSubSelectionForNode(
        target.node,
        TextSelection.create([new StoryRange(target.begin, target.end)])
      );
      builder.addCommand(DocumentCommand.createFormatText(
        selection,
        StoryDelta.createGlyphDouble(target.attribute, value)
      ));
      applied[target.attribute]++;
      if (target.value !== undefined) resetCommandCount++;
    } catch (error) {
      errors.push(`排版调整（索引 ${target.begin}）：${errorMessage(error)}`);
    }
  }

  const commandCount = applied[GlyphAttDoubleType.CharacterSpacing]
    + applied[GlyphAttDoubleType.ManualKerning];
  if (commandCount > 0) {
    try {
      doc.executeCommand(builder.createCommand());
      succeeded = true;
    } catch (error) {
      errors.push(`执行排版调整失败：${errorMessage(error)}`);
    }
  }
  return { ...applied, commandCount, resetCommandCount, succeeded };
}

function scanParagraphBoundaries(text, label, findings) {
  const breakPattern = /\r\n|\r|\n|\u2028|\u2029/g;
  let start = 0;
  let paragraphNumber = 1;
  let match;

  function inspectParagraph(paragraph, paragraphStart, number) {
    const leading = paragraph.match(/^\s*/u)?.[0].length || 0;
    const trimmed = paragraph.trim();
    if (!trimmed) return;

    const trimmedPoints = Array.from(trimmed);
    const first = trimmedPoints[0];
    const last = trimmedPoints[trimmedPoints.length - 1];
    const startOffset = paragraphStart + leading;
    const endOffset = paragraphStart + paragraph.trimEnd().length - 1;

    if (/[，。！？；：、,.!?;:）】》」』]/u.test(first)) {
      addFinding(
        findings, '段首标点',
        `第 ${number} 段以标点或闭合符号开头；请检查是否为有意分段`,
        `${label}: “${trimmed.slice(0, 28)}”`,
        startOffset, number
      );
    }
    if (/[（【《「『([{〔〖〘〚]/u.test(last)) {
      addFinding(
        findings, '段末标点',
        `第 ${number} 段以开括号或开引号结尾；请检查是否为有意分段`,
        `${label}: “${trimmed.slice(-28)}”`,
        endOffset, number
      );
    }
  }

  while ((match = breakPattern.exec(text)) !== null) {
    inspectParagraph(text.slice(start, match.index), start, paragraphNumber);
    start = match.index + match[0].length;
    paragraphNumber++;
  }
  inspectParagraph(text.slice(start), start, paragraphNumber);
}

function scanBrackets(text, label, findings, paragraphAtOffset) {
  const stack = [];
  let paragraphStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPEN_TO_CLOSE.has(ch)) {
      const continuedDialogueQuote = ch === '「' &&
        stack.some(item => item.ch === '「') &&
        text.slice(paragraphStart, i).trim() === '';
      if (!continuedDialogueQuote) {
        stack.push({ ch, expected: OPEN_TO_CLOSE.get(ch), offset: i });
      }
    } else if (CLOSE_TO_OPEN.has(ch)) {
      const expectedOpen = CLOSE_TO_OPEN.get(ch);
      const top = stack[stack.length - 1];
      if (!top || top.ch !== expectedOpen) {
        addFinding(
          findings, '括号配对',
          `位置 ${i} 出现未匹配或顺序异常的闭合符号 “${ch}”`,
          `${label}: “…${excerpt(text, i)}…”`,
          i, paragraphAtOffset(i)
        );
      } else {
        stack.pop();
      }
    }
    if (ch === '\r' || ch === '\n' || ch === '\u2028' || ch === '\u2029') {
      paragraphStart = i + 1;
    }
  }

  for (const item of stack) {
    addFinding(
      findings, '括号配对',
      `位置 ${item.offset} 的开符号 “${item.ch}” 尚未找到对应的 “${item.expected}”`,
      `${label}: “…${excerpt(text, item.offset)}…”`,
      item.offset, paragraphAtOffset(item.offset)
    );
  }
}

function scanStory(text, label, findings) {
  if (!text || !text.length) return;
  const paragraphAtOffset = createParagraphLookup(text);

  if (CONFIG.checkParagraphBoundaries) {
    scanParagraphBoundaries(text, label, findings);
  }

  const points = codePoints(text);
  if (CONFIG.cjkLatinAdjacency !== 'ignore') {
    for (let i = 1; i < points.length; i++) {
      const left = points[i - 1].ch;
      const right = points[i].ch;
      if ((isCjk(left) && isLatinOrDigit(right)) ||
          (isLatinOrDigit(left) && isCjk(right))) {
        addFinding(
          findings, '中西文邻接',
          '中文与 Latin/数字直接相邻；可按字体、字号和版面密度检查视觉字距',
          `${label}: “…${excerpt(text, points[i].offset)}…”`,
          points[i].offset, paragraphAtOffset(points[i].offset)
        );
      }
    }
  }

  // Whitespace is policy-dependent: do not silently remove it.
  for (let i = 0; i < points.length; i++) {
    if (points[i].ch !== ' ' && points[i].ch !== '\u3000') continue;
    const left = points[i - 1]?.ch || '';
    const right = points[i + 1]?.ch || '';
    const cjkLatinBoundary =
      (isCjk(left) && isLatinOrDigit(right)) ||
      (isLatinOrDigit(left) && isCjk(right));

    if (cjkLatinBoundary && CONFIG.cjkLatinSpacePolicy !== 'ignore') {
      const isStrict = CONFIG.cjkLatinSpacePolicy === 'strict-no-space';
      addFinding(
        findings, '中西文空格',
        isStrict
          ? '当前规则集将中西文之间的空格列为待处理项'
          : '中西文之间存在空格；这属于版式规范选择，请按全文规则统一',
        `${label}: “…${excerpt(text, points[i].offset)}…”`,
        points[i].offset, paragraphAtOffset(points[i].offset)
      );
    } else if (isCjk(left) && isCjk(right)) {
      addFinding(
        findings, '中西文空格',
        '两个 CJK 字符之间出现空格；请确认是否为有意留白',
        `${label}: “…${excerpt(text, points[i].offset)}…”`,
        points[i].offset, paragraphAtOffset(points[i].offset)
      );
    }
  }

  if (CONFIG.checkRepeatedSpaces) {
    const repeated = /[ \u3000]{2,}/g;
    let match;
    while ((match = repeated.exec(text)) !== null) {
      addFinding(
        findings, '重复空格',
        `发现连续空格（${match[0].length} 个）；请检查是否为手工对齐或误输入`,
        `${label}: “…${excerpt(text, match.index)}…”`,
        match.index, paragraphAtOffset(match.index)
      );
    }
  }

  if (CONFIG.checkAsciiPunctuation) {
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!ASCII_PUNCT.test(point.ch)) continue;
      const left = points[i - 1]?.ch || '';
      const right = points[i + 1]?.ch || '';
      if (isCjk(left) || isCjk(right)) {
        addFinding(
          findings, '半角标点',
          `半角标点 “${point.ch}” 与 CJK 字符相邻。${(PROFILES[CONFIG.profile] || PROFILES.custom).punctuationHint}`,
          `${label}: “…${excerpt(text, point.offset)}…”`,
          point.offset, paragraphAtOffset(point.offset)
        );
      }
    }
  }

  if (CONFIG.checkRepeatedPunctuation) {
    const repeated = /([，。！？；：、,.!?;:])\1+/gu;
    let match;
    while ((match = repeated.exec(text)) !== null) {
      addFinding(
        findings, '连续标点',
        `发现连续标点 “${match[0]}”；请确认是否为有意表达`,
        `${label}: “…${excerpt(text, match.index)}…”`,
        match.index, paragraphAtOffset(match.index)
      );
    }
  }

  if (CONFIG.checkBracketPairs) {
    scanBrackets(text, label, findings, paragraphAtOffset);
  }
}

function formatReport(findings, scannedStories, scannedChars, errors, formattingSummary) {
  let total = 0;
  for (const key of Object.keys(findings)) total += findings[key].length;

  const profile = PROFILES[CONFIG.profile] || PROFILES.custom;
  let report = `Affinity CJK Typography Toolkit ${VERSION}\n`;
  report += `规则集：${profile.label}\n`;
  report += `扫描文本故事：${scannedStories} 个\n扫描字符：${scannedChars}\n发现项目：${total}\n`;
  report += `\n说明：排版调整须在对话框中勾选；所有调整合并为一次可撤销操作。\n`;
  report += `位置采用文本字符串的 UTF-16 索引，并同时标注段落序号。\n`;
  report += `中西文空格与邻接提示受 CONFIG 中的策略设置影响。\n`;
  if (formattingSummary) report += `${formattingSummary}\n`;

  for (const category of CATEGORY_ORDER) {
    const items = findings[category];
    if (!items || !items.length) continue;
    report += `\n【${category}】${items.length} 项\n`;
    const shown = items.slice(0, CONFIG.maxExamplesPerCategory);
    for (const item of shown) {
      const where = item.offset === undefined
        ? ''
        : `（索引 ${item.offset}，第 ${item.paragraph || '?'} 段）`;
      report += `• ${item.message}${where}\n  ${item.sample}\n`;
    }
    if (items.length > shown.length) {
      report += `…另有 ${items.length - shown.length} 项未显示\n`;
    }
  }

  if (errors.length) {
    report += `\n【处理异常】${errors.length} 项\n`;
    for (const error of errors) report += `• ${error}\n`;
  }
  if (!total && !errors.length) report += `\n未发现本工具当前规则覆盖的问题。`;
  return report;
}

function validateConfig() {
  const errors = [];
  if (!Object.prototype.hasOwnProperty.call(PROFILES, CONFIG.profile)) {
    errors.push(`profile “${CONFIG.profile}” 不受支持。`);
  }
  if (!['review', 'ignore', 'strict-no-space'].includes(CONFIG.cjkLatinSpacePolicy)) {
    errors.push(`cjkLatinSpacePolicy “${CONFIG.cjkLatinSpacePolicy}” 不受支持。`);
  }
  if (!['review', 'ignore'].includes(CONFIG.cjkLatinAdjacency)) {
    errors.push(`cjkLatinAdjacency “${CONFIG.cjkLatinAdjacency}” 不受支持。`);
  }
  if (!Number.isInteger(CONFIG.maxExamplesPerCategory) ||
      CONFIG.maxExamplesPerCategory < 0) {
    errors.push('maxExamplesPerCategory 必须是大于或等于 0 的整数。');
  }
  for (const key of [
    'scanLinkedStoryOnce',
    'checkAsciiPunctuation',
    'checkRepeatedPunctuation',
    'checkBracketPairs',
    'checkParagraphBoundaries',
    'checkRepeatedSpaces',
  ]) {
    if (typeof CONFIG[key] !== 'boolean') {
      errors.push(`${key} 必须是布尔值。`);
    }
  }
  return errors;
}

function main() {
  const configErrors = validateConfig();
  if (configErrors.length) {
    alert(`CONFIG 配置无效：\n• ${configErrors.join('\n• ')}`);
    return;
  }

  const doc = Document.current;
  if (!doc) {
    alert('请先打开一个 Affinity 文档。');
    return;
  }

  const selected = doc.selection.nodes.toArray().filter(n => n.isTextNode);
  if (!selected.length) {
    alert('请先选择一个或多个文本对象（文本框或艺术字）。');
    return;
  }

  const seenStories = new Set();
  const findings = {};
  const errors = [];
  const selectedStories = [];
  let scannedStories = 0;
  let scannedChars = 0;

  for (let i = 0; i < selected.length; i++) {
    try {
      const node = selected[i];
      const story = node.story;
      if (!story) {
        errors.push(`文本对象 ${i + 1} 没有可读取的 Story。`);
        continue;
      }
      if (CONFIG.scanLinkedStoryOnce && seenStories.has(story)) continue;
      seenStories.add(story);

      const text = getStoryText(story);

      scannedStories++;
      scannedChars += Array.from(text).length;
      scanStory(text, `文本对象 ${i + 1}`, findings);
      selectedStories.push({ node, text, label: `文本对象 ${i + 1}` });
    } catch (error) {
      errors.push(`文本对象 ${i + 1}：${errorMessage(error)}`);
    }
  }

  const candidates = { cjkLatin: [], punctuationRuns: [] };
  const resetRanges = [];
  for (const item of selectedStories) {
    let nodeRange;
    try {
      nodeRange = getNodeStoryText(item.node);
    } catch (error) {
      errors.push(`${item.label}（文本范围）：${errorMessage(error)}`);
      continue;
    }
    resetRanges.push({
      node: item.node,
      story: nodeRange.story,
      begin: nodeRange.begin,
      end: nodeRange.end,
    });

    try {
      candidates.cjkLatin.push(...findCjkLatinBoundaries(item.node, nodeRange.text, nodeRange));
    } catch (error) {
      errors.push(`${item.label}（中西文字距）：${errorMessage(error)}`);
    }
    try {
      candidates.punctuationRuns.push(...findConsecutivePunctuationTargets(item.node, nodeRange.text, nodeRange));
    } catch (error) {
      errors.push(`${item.label}（连续标点）：${errorMessage(error)}`);
    }
  }

  const counts = {
    cjkLatin: candidates.cjkLatin.length,
    punctuationRuns: candidates.punctuationRuns.length,
    punctuationSample: candidates.punctuationRuns[0]?.sample || '',
    resetRanges: resetRanges.length,
  };
  const candidateSummary = `可选调整位置：中西文 ${counts.cjkLatin} 处、连续标点间距 ${counts.punctuationRuns} 处。`;
  let formattingSummary = `${candidateSummary} 尚未应用。`;
  const options = requestTypographyOptions(counts);
  if (options) {
    const resetTargets = [];
    if (options.resetSpacing) {
      collectResetTargets(resetTargets, resetRanges);
    }

    const targets = [...resetTargets];
    const targetLookup = new Map();

    if (options.applySpacing) {
      if (!Number.isFinite(options.spacingAmount) || Math.abs(options.spacingAmount) > 0.5) {
        errors.push('中西文字距增量必须在 -0.5 至 0.5 em 之间。');
      } else if (options.spacingAmount !== 0) {
        collectFormattingTargets(
          targets, targetLookup, candidates.cjkLatin,
          GlyphAttDoubleType.CharacterSpacing, options.spacingAmount
        );
      }
    }

    if (options.applyRuns) {
      if (!Number.isFinite(options.runAmount) ||
          options.runAmount < -1 || options.runAmount > 0) {
        errors.push('连续标点间距增量必须在 -1 至 0 em 之间。');
      } else if (options.runAmount !== 0) {
        collectFormattingTargets(
          targets, targetLookup, candidates.punctuationRuns,
          GlyphAttDoubleType.ManualKerning, options.runAmount
        );
      }
    }

    if (targets.length) {
      const applied = applyTypographyAdjustments(doc, targets, errors);
      formattingSummary = applied.succeeded
        ? options.resetSpacing
          ? `已应用（单次撤销）：已执行字符间距/字偶距归零命令 ${applied.resetCommandCount} 项；另执行字距调整 ${Math.max(0, applied.commandCount - applied.resetCommandCount)} 项。`
          : `已应用（单次撤销）：中西文字符间距 ${applied[GlyphAttDoubleType.CharacterSpacing]} 处，连续标点字偶距 ${applied[GlyphAttDoubleType.ManualKerning]} 处。`
        : '排版调整未应用；请查看处理异常。';
    } else {
      formattingSummary = `未应用排版调整。${candidateSummary}`;
    }
  }

  alert(formatReport(findings, scannedStories, scannedChars, errors, formattingSummary));
}

main();
