// Affinity CJK Regex Tracking
// Version: 0.8.2
// Apply 250‰ Tracking to CJK/Latin boundaries and -500‰ to punctuation that
// trails blank space (dot punctuation, closing quotes and brackets) when it is
// followed by punctuation.
// Scope: the selected text characters when characters are really selected,
// otherwise the whole document.
// Target: Affinity by Canva desktop scripting API (SDK 3.3.x)
// License: MIT

'use strict';

const { Document } = require('/document.js');
const { GlyphAttDoubleType } = require('/glyphatts.js');
const { Selection, TextSelection, SubSelectionType } = require('/selections.js');
const { StoryDelta } = require('/storydelta.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { StoryRange } = require('affinity:story');
const { NodeChildType, NodeChildrenOnly } = require('/nodes.js');

const VERSION = '0.8.2';

// 点号：字形在左侧、右侧留有空白，后接标点时压缩这格空白。
const DOT_PUNCTUATION = '、。，．；：？！';
// 开引号、开括号的空白在左侧，压缩它们只会让后续字形压到自身墨迹上。
const OPENING_PUNCTUATION = '‘“〝（［｛〈《「『【〔〖〘〚';
// 后引号、后括号的空白在右侧，后接点号时压缩。
const CLOSING_PUNCTUATION = '”’〞〟）］｝〉》」』】〕〗〙〛';
const CJK_PUNCTUATION =
  `${OPENING_PUNCTUATION}${CLOSING_PUNCTUATION}${DOT_PUNCTUATION}`;

const RULES = [
  {
    name: '中西文字符间距',
    tracking: 0.250,
    regexes: [
      /[ぁ-ゖァ-ー\u32FF㍻-㍾\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF](?=[0-9A-Za-z])/gu,
      /[0-9A-Za-z](?=[ぁ-ゖァ-ー\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/gu,
    ],
  },
  {
    name: '标点挤压',
    tracking: -0.5,
    regexes: [
      // 点号后接任意中日韩标点：压缩点号右侧空白。
      new RegExp(`[${DOT_PUNCTUATION}](?=[${CJK_PUNCTUATION}])`, 'gu'),
      // 后引号、后括号紧邻点号：压缩其右侧空白。
      new RegExp(`[${CLOSING_PUNCTUATION}](?=[${DOT_PUNCTUATION}])`, 'gu'),
    ],
  },
];

function formatTracking(tracking) {
  return `${Math.round(tracking * 1000)}‰`;
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function storyIdentity(story) {
  return story && story.handle !== undefined ? story.handle : story;
}

function nodeIdentity(node) {
  return node && node.handle !== undefined ? node.handle : node;
}

const storyInfoCache = new Map();

function getStoryInfo(story) {
  if (typeof story.text === 'string') {
    return { text: story.text, gap: story.text.length };
  }
  const identity = storyIdentity(story);
  const cached = storyInfoCache.get(identity);
  if (cached !== undefined) return cached;

  if (typeof story.getLength !== 'function' || typeof story.getText !== 'function') {
    throw new Error('Story 未返回可读取的文本字符串。');
  }
  const length = story.getLength();
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`Story 返回了无效文本长度：${length}。`);
  }
  const text = story.getText(0, length);
  if (typeof text !== 'string') {
    throw new Error('Story.getText 未返回文本字符串。');
  }
  if (text.length > length) {
    throw new Error(
      `Story.getText 返回长度超出 Story 长度（应为 ${length}，实际为 ${text.length}）。`
    );
  }
  // Story 末尾常带一个 getText 读不出的字符（例如末段落标记），可读文本会比
  // getLength() 短。用二分查找定位第一个读不出的位置，确保此前的坐标仍然对齐。
  let gap = text.length;
  if (text.length < length) {
    gap = findFirstUnreadableOffset(story, length);
    if (!(gap >= 0 && gap <= text.length)) gap = text.length;
  }
  const info = { text, gap };
  storyInfoCache.set(identity, info);
  return info;
}

function findFirstUnreadableOffset(story, length) {
  let low = 1;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    let readable = false;
    try {
      readable = story.getText(0, middle).length === middle;
    } catch (error) {
      readable = false;
    }
    if (readable) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function readStoryRangeText(story, begin, end) {
  if (end <= begin) return { text: '', trimmed: false };
  const info = getStoryInfo(story);
  const readableEnd = Math.min(end, info.gap);
  if (readableEnd <= begin) {
    return { failure: `StoryRange 起点 ${begin} 之后没有可读文本。` };
  }

  const length = readableEnd - begin;
  let text;
  try {
    text = story.getText(begin, length);
  } catch (error) {
    return { failure: `StoryRange 读取失败：${errorMessage(error)}` };
  }
  if (typeof text !== 'string' || text.length !== length) {
    return {
      failure:
        `Story.getText 长度不匹配（应为 ${length}，` +
        `实际为 ${typeof text === 'string' ? text.length : '无效'}）。`,
    };
  }
  return { text, trimmed: readableEnd < end };
}

function getNodeStoryText(node) {
  const storyInterface = node.storyInterface;
  const interfaceSource = storyInterface && {
    story: storyInterface.story,
    range: storyInterface.storyRange,
    selectionNode: storyInterface.node || node,
  };
  const sources = [
    { story: node.story, range: node.storyRange, selectionNode: node },
    interfaceSource,
  ].filter(source => source && source.story && source.range);
  const failures = [];

  for (const source of sources) {
    const { story, range, selectionNode } = source;
    const end = Number.isInteger(range.end)
      ? range.end
      : Number.isInteger(range.begin) && Number.isInteger(range.length)
        ? range.begin + range.length
        : NaN;
    if (!Number.isInteger(range.begin) || !Number.isInteger(end) ||
        range.begin < 0 || end < range.begin) {
      failures.push('StoryRange 无效');
      continue;
    }

    const read = readStoryRangeText(story, range.begin, end);
    if (read.text !== undefined) {
      const sameInterfaceRange = interfaceSource &&
        interfaceSource.range &&
        storyIdentity(interfaceSource.story) === storyIdentity(story) &&
        interfaceSource.range.begin === range.begin &&
        (Number.isInteger(interfaceSource.range.end)
          ? interfaceSource.range.end
          : interfaceSource.range.begin + interfaceSource.range.length) === end;
      const fallbackNode = selectionNode === node && sameInterfaceRange
        ? interfaceSource.selectionNode
        : null;
      return {
        story,
        begin: range.begin,
        end: range.begin + read.text.length,
        text: read.text,
        trimmed: read.trimmed,
        selectionNode,
        fallbackNode,
      };
    }
    failures.push(read.failure);

    try {
      const info = getStoryInfo(story);
      const readableEnd = Math.min(end, info.gap);
      if (readableEnd > range.begin) {
        return {
          story,
          begin: range.begin,
          end: readableEnd,
          text: info.text.slice(range.begin, readableEnd),
          trimmed: readableEnd < end,
          selectionNode,
          fallbackNode: null,
        };
      }
      failures.push('Story 全文与 StoryRange 坐标不一致');
    } catch (error) {
      failures.push(`Story 全文读取失败：${errorMessage(error)}`);
    }
  }

  throw new Error(
    `无法取得与格式目标对齐的 Story 文本：${failures.join('；') || '无可用范围'}`
  );
}

// 母版 spread 不在 doc.spreads 里，需要按 NodeChildType.MasterSpread 从根节点取。
function getMasterSpreads(doc) {
  if (NodeChildType && NodeChildType.MasterSpread !== undefined && NodeChildrenOnly) {
    const root = doc.rootNode;
    if (root) {
      return new NodeChildrenOnly(root.handle, NodeChildType.MasterSpread, false);
    }
  }
  if (doc.masterSpreads) return doc.masterSpreads;
  return null;
}

function collectTextNodes(doc, sources) {
  const roots = [];
  const errors = [];
  let masterAccessible = false;
  for (const [kind, label, isMaster] of sources) {
    try {
      let spreads = null;
      if (kind === 'pages') spreads = doc.spreads;
      else if (kind === 'masters') spreads = getMasterSpreads(doc);
      if (!spreads) continue;
      if (typeof spreads.toArray === 'function') spreads = spreads.toArray();
      if (!spreads || typeof spreads.length !== 'number') {
        throw new Error('SDK 未返回有效节点集合。');
      }
      if (isMaster) masterAccessible = true;
      for (const node of spreads) roots.push({ node, label, isMaster });
    } catch (error) {
      errors.push(`读取${label}列表失败：${errorMessage(error)}`);
    }
  }

  const nodes = [];
  const visited = new Set();
  for (let cursor = 0; cursor < roots.length; cursor++) {
    const { node, label, isMaster } = roots[cursor];
    if (!node) continue;
    const identity = nodeIdentity(node);
    if (visited.has(identity)) continue;
    visited.add(identity);

    try {
      if (node.isTextNode) {
        nodes.push({ node, label: `${label}文本对象 ${nodes.length + 1}`, isMaster });
      }
    } catch (error) {
      errors.push(`读取文本节点属性失败：${errorMessage(error)}`);
    }

    try {
      const children = node.children;
      if (children && typeof children.toArray === 'function') {
        for (const child of children.toArray()) roots.push({ node: child, label, isMaster });
      } else if (children) {
        throw new Error('SDK 未返回有效子节点集合。');
      }
    } catch (error) {
      errors.push(`读取节点子项失败：${errorMessage(error)}`);
    }
  }
  return { nodes, errors, masterAccessible };
}

function collectDocumentTextNodes(doc) {
  return collectTextNodes(doc, [
    ['pages', '页面', false],
    ['masters', '母版页', true],
  ]);
}

function collectMasterTextNodes(doc) {
  return collectTextNodes(doc, [['masters', '母版页', true]]);
}

// 页面上的母版实例与母版源文本框共享同一个 Story，写入要通过母版源节点才会生效。
function buildMasterStoryMap(nodes) {
  const map = new Map();
  for (const item of nodes) {
    if (!item.isMaster) continue;
    try {
      const story = item.node.story;
      const range = item.node.storyRange;
      if (!story || !range) continue;
      const identity = storyIdentity(story);
      let entries = map.get(identity);
      if (!entries) {
        entries = [];
        map.set(identity, entries);
      }
      entries.push({
        node: item.node,
        begin: Number.isInteger(range.begin) ? range.begin : 0,
        end: Number.isInteger(range.end) ? range.end : 0,
      });
    } catch (error) {
      // 读不到 Story 的母版节点不参与路由
    }
  }
  return map;
}

function findMasterSource(masterByStory, story, begin, end) {
  if (!masterByStory) return null;
  const entries = masterByStory.get(storyIdentity(story));
  if (!entries) return null;
  // 同一 Story 可能有多个链式母版文本框，取覆盖当前范围的第一个
  for (const entry of entries) {
    if (begin >= entry.begin && end <= entry.end) return entry.node;
  }
  return null;
}

// 同一 Story 上的所有文本对象（页面实例、母版源）都可以作为写入候选。
function buildStoryNodeMap(nodes) {
  const map = new Map();
  for (const item of nodes) {
    try {
      const story = item.node.story;
      if (!story) continue;
      const identity = storyIdentity(story);
      let list = map.get(identity);
      if (!list) {
        list = [];
        map.set(identity, list);
      }
      if (!list.some(node => nodeIdentity(node) === nodeIdentity(item.node))) {
        list.push(item.node);
      }
    } catch (error) {
      // 读不到 Story 的节点跳过
    }
  }
  return map;
}

function createScope(
  range, scanLength, label, masterByStory, masterInstance, storyNodes
) {
  return {
    label,
    story: range.story,
    begin: range.begin,
    end: range.end,
    text: range.text,
    scanLength,
    masterByStory,
    masterInstance: !!masterInstance,
    storyNodes: storyNodes || [],
    selectionNode: range.selectionNode,
    fallbackNode: range.fallbackNode,
  };
}

function collectDocumentScopes(nodes, errors, masterByStory) {
  const scopes = [];
  const storyNodes = buildStoryNodeMap(nodes);
  let trimmed = 0;
  let masterInstances = 0;
  for (const item of nodes) {
    try {
      const range = getNodeStoryText(item.node);
      if (range.trimmed) trimmed++;
      let masterInstance = false;
      if (!item.isMaster) {
        try {
          masterInstance = !!item.node.isMasterEditable;
        } catch (error) {
          masterInstance = false;
        }
      }
      if (masterInstance) masterInstances++;
      scopes.push(createScope(
        range, range.text.length, item.label, masterByStory, masterInstance,
        storyNodes.get(storyIdentity(range.story))
      ));
    } catch (error) {
      errors.push(`${item.label}：${errorMessage(error)}`);
    }
  }
  return { scopes, trimmed, masterInstances };
}

function getTextSelection(item) {
  if (typeof item.getSubSelectionOfType === 'function' && SubSelectionType) {
    try {
      const found = item.getSubSelectionOfType(SubSelectionType.Text);
      if (found) return found;
    } catch (error) {
      // 回退到子选区列表
    }
  }
  let subSelections;
  try {
    subSelections = item.subSelections;
  } catch (error) {
    return null;
  }
  for (const subSelection of subSelections || []) {
    if (subSelection instanceof TextSelection) return subSelection;
  }
  return null;
}

function getSelectedRanges(textSelection) {
  if (!textSelection) return [];
  let ranges;
  try {
    ranges = textSelection.ranges;
  } catch (error) {
    return [];
  }
  const result = [];
  for (const range of ranges || []) {
    const begin = range && range.begin;
    const end = range && range.end;
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin === end) continue;
    result.push({ begin: Math.min(begin, end), end: Math.max(begin, end) });
  }
  return result;
}

// 只统计真正选中的文本字符；返回 null 表示当前没有选中文本。
function readSelectionSelections(doc, errors) {
  let selection;
  try {
    selection = doc.selection;
  } catch (error) {
    errors.push(`读取当前选取项失败：${errorMessage(error)}`);
    return null;
  }
  let count = 0;
  try {
    count = selection ? selection.length : 0;
  } catch (error) {
    errors.push(`读取当前选取项数量失败：${errorMessage(error)}`);
    return null;
  }
  if (!count) return null;

  const selections = [];
  for (let index = 0; index < count; index++) {
    let item;
    try {
      item = selection.at(index);
    } catch (error) {
      errors.push(`读取选取项 ${index + 1} 失败：${errorMessage(error)}`);
      continue;
    }
    let node = null;
    let isTextNode = false;
    try {
      node = item ? item.node : null;
      isTextNode = !!node && !!node.isTextNode;
    } catch (error) {
      isTextNode = false;
    }
    if (!isTextNode) continue;
    const ranges = getSelectedRanges(getTextSelection(item));
    if (!ranges.length) continue;
    selections.push({ node, ranges });
  }
  return selections.length ? selections : null;
}

function collectSelectionScopes(selections, errors, masterByStory) {
  const scopes = [];
  let trimmed = 0;
  let nodeIndex = 0;
  for (const { node, ranges } of selections) {
    const label = `选取项文本 ${++nodeIndex}`;
    let range;
    try {
      range = getNodeStoryText(node);
    } catch (error) {
      errors.push(`${label}：${errorMessage(error)}`);
      continue;
    }
    if (range.trimmed) trimmed++;

    for (const selected of ranges) {
      const begin = Math.max(selected.begin, range.begin);
      const end = Math.min(selected.end, range.end);
      if (end <= begin) continue;
      // 多读一个字符，让选区末位的字符也能拿到后一个字符作为匹配上下文。
      const contextEnd = Math.min(end + 1, range.end);
      const offset = range.begin;
      let masterInstance = false;
      try {
        masterInstance = !!node.isMasterEditable;
      } catch (error) {
        masterInstance = false;
      }
      const masterEntries = masterByStory
        ? masterByStory.get(storyIdentity(range.story))
        : null;
      scopes.push(createScope({
        story: range.story,
        begin,
        end,
        text: range.text.slice(begin - offset, contextEnd - offset),
        selectionNode: range.selectionNode,
        fallbackNode: range.fallbackNode,
      }, end - begin, label, masterByStory, masterInstance,
      masterEntries ? masterEntries.map(entry => entry.node) : []));
    }
  }
  return { scopes, trimmed };
}

function addAlternative(target, range) {
  const identity = nodeIdentity(range.selectionNode);
  if (!range.selectionNode || identity === nodeIdentity(target.node)) return;
  if (target.alternatives.some(alt => nodeIdentity(alt.node) === identity)) return;
  target.alternatives.push({
    node: range.selectionNode,
    fallbackNode: range.fallbackNode,
  });
}

function collectRegexTargets(scopes, errors) {
  const targets = [];
  const seen = new Map();
  let routed = 0;
  let unmatched = 0;
  const stats = new Map(RULES.map(rule => [
    rule.name,
    { tracking: rule.tracking, matches: 0, skipped: 0, applied: 0, failed: 0 },
  ]));

  for (const range of scopes) {
    try {
      for (const rule of RULES) {
        const stat = stats.get(rule.name);
        for (const regex of rule.regexes) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(range.text)) !== null) {
            if (match.index >= range.scanLength) break;
            const begin = range.begin + match.index;
            const end = begin + match[0].length;
            let storyTargets = seen.get(storyIdentity(range.story));
            if (!storyTargets) {
              storyTargets = new Map();
              seen.set(storyIdentity(range.story), storyTargets);
            }
            const key = `${begin}:${end}:${rule.tracking}`;
            const existing = storyTargets.get(key);
            if (existing) {
              addAlternative(existing, range);
              continue;
            }
            stat.matches++;

            let actualText;
            try {
              actualText = typeof range.story.getText === 'function'
                ? range.story.getText(begin, end - begin)
                : match[0];
            } catch (error) {
              stat.failed++;
              errors.push(
                `${range.label}，索引 ${begin} “${match[0]}”无法校验文本：` +
                `${errorMessage(error)}`
              );
              continue;
            }
            if (actualText !== match[0]) {
              stat.failed++;
              errors.push(
                `${range.label}，索引 ${begin}：正则命中“${match[0]}”，` +
                `但 StoryRange 对应“${String(actualText)}”；已跳过以避免错位。`
              );
              continue;
            }

            try {
              const glyphAtts = range.story.getGlyphAtts(begin);
              const currentTracking =
                glyphAtts.getDoubleValue(GlyphAttDoubleType.CharacterSpacing);
              if (!Number.isFinite(currentTracking)) {
                throw new Error('Tracking 不是有效数值。');
              }
              if (Math.abs(currentTracking - rule.tracking) < 1e-6) {
                stat.skipped++;
                continue;
              }
            } catch (error) {
              stat.failed++;
              errors.push(
                `${range.label}，索引 ${begin} “${match[0]}”无法读取 Tracking：` +
                `${errorMessage(error)}`
              );
              continue;
            }

            // 母版实例的字符要通过母版源文本框写入才会生效
            const masterNode =
              findMasterSource(range.masterByStory, range.story, begin, end);
            if (masterNode) routed++;
            else if (range.masterInstance) unmatched++;

            const targetNode = masterNode || range.selectionNode;
            const alternatives = [];
            const addNode = node => {
              if (!node) return;
              const identity = nodeIdentity(node);
              if (identity === nodeIdentity(targetNode)) return;
              if (alternatives.some(alt => nodeIdentity(alt.node) === identity)) return;
              alternatives.push({ node, fallbackNode: null });
            };
            addNode(range.fallbackNode);
            for (const node of range.storyNodes) addNode(node);

            targets.push({
              ruleName: rule.name,
              tracking: rule.tracking,
              node: targetNode,
              fallbackNode: masterNode ? range.selectionNode : range.fallbackNode,
              alternatives,
              story: range.story,
              begin,
              end,
              sample: match[0],
              label: range.label,
            });
            storyTargets.set(key, targets[targets.length - 1]);
          }
        }
      }
    } catch (error) {
      errors.push(`${range.label}：${errorMessage(error)}`);
    }
  }
  return { targets, stats, routed, unmatched };
}

function createFormattingCommand(doc, target, node) {
  const selection = Selection.create(doc, node);
  selection.addSubSelectionForNode(
    node,
    TextSelection.create([new StoryRange(target.begin, target.end)])
  );
  return DocumentCommand.createFormatText(
    selection,
    StoryDelta.createGlyphDouble(
      GlyphAttDoubleType.CharacterSpacing,
      target.tracking
    )
  );
}

function nodeFlags(node) {
  const flags = [];
  try {
    if (node.isMasterEditable) flags.push('母版可编辑');
  } catch (error) {
    // 忽略
  }
  try {
    if (node.isLocalEditable) flags.push('本地可编辑');
  } catch (error) {
    // 忽略
  }
  try {
    if (!node.isEditable) flags.push('锁定');
  } catch (error) {
    // 忽略
  }
  return flags.length ? `（${flags.join('，')}）` : '';
}

function isTrackingApplied(target) {
  try {
    const atts = target.story.getGlyphAtts(target.begin);
    const value = atts.getDoubleValue(GlyphAttDoubleType.CharacterSpacing);
    return Math.abs(value - target.tracking) < 1e-6;
  } catch (error) {
    // 读不到时按已生效处理，避免重复执行同一条命令
    return true;
  }
}

function executeTarget(doc, target) {
  const candidates = [];
  const addCandidate = node => {
    if (!node) return;
    const identity = nodeIdentity(node);
    if (candidates.some(existing => nodeIdentity(existing) === identity)) return;
    candidates.push(node);
  };
  addCandidate(target.node);
  addCandidate(target.fallbackNode);
  for (const alternative of target.alternatives) {
    addCandidate(alternative.node);
    addCandidate(alternative.fallbackNode);
  }

  const failures = [];
  for (const node of candidates) {
    try {
      doc.executeCommand(createFormattingCommand(doc, target, node));
    } catch (error) {
      failures.push(`节点 ${nodeIdentity(node)}${nodeFlags(node)}：${errorMessage(error)}`);
      continue;
    }
    // 母版实例等节点上执行命令可能静默无效，确认 Tracking 真的落盘再算成功
    if (isTrackingApplied(target)) return;
    failures.push(
      `节点 ${nodeIdentity(node)}${nodeFlags(node)} 命令已执行但 Tracking 未变化`
    );
  }
  throw new Error(failures.join('；') || '没有可用的格式目标节点。');
}

function applyRegexTargets(doc, targets, errors, stats) {
  const groups = new Map();
  for (const target of targets) {
    const key = `${nodeIdentity(target.node)}:${target.ruleName}`;
    let group = groups.get(key);
    if (!group) {
      group = { label: target.label, targets: [] };
      groups.set(key, group);
    }
    group.targets.push(target);
  }

  const recordFailure = (target, error) => {
    stats.get(target.ruleName).failed++;
    errors.push(
      `${target.label}，${target.ruleName}，索引 ${target.begin}` +
      `，Story ${storyIdentity(target.story)}，节点 ${nodeIdentity(target.node)} ` +
      `“${target.sample}”：${errorMessage(error)}`
    );
  };

  for (const group of groups.values()) {
    const builder = CompoundCommandBuilder.create();
    const validTargets = [];
    for (const target of group.targets) {
      try {
        builder.addCommand(
          createFormattingCommand(doc, target, target.node)
        );
        validTargets.push(target);
      } catch (error) {
        recordFailure(target, error);
      }
    }
    if (!validTargets.length) continue;

    try {
      doc.executeCommand(builder.createCommand());
      const pending = [];
      for (const target of validTargets) {
        if (isTrackingApplied(target)) stats.get(target.ruleName).applied++;
        else pending.push(target);
      }
      // 批量命令对母版实例等节点可能静默无效，逐个换节点重试
      for (const target of pending) {
        try {
          executeTarget(doc, target);
          stats.get(target.ruleName).applied++;
        } catch (error) {
          recordFailure(target, error);
        }
      }
    } catch (batchError) {
      let allRecovered = true;
      for (const target of validTargets) {
        try {
          executeTarget(doc, target);
          stats.get(target.ruleName).applied++;
        } catch (error) {
          allRecovered = false;
          recordFailure(target, error);
        }
      }
      if (!allRecovered) {
        errors.push(
          `${group.label}批量调整失败，已逐个重试：` +
          `${errorMessage(batchError)}`
        );
      }
    }
  }
}

function main() {
  let doc;
  try {
    doc = Document.current;
  } catch (error) {
    alert(`读取当前文档失败：${errorMessage(error)}`);
    return;
  }
  if (!doc) {
    alert('请先打开一个 Affinity 文档。');
    return;
  }

  const errors = [];
  const selections = readSelectionSelections(doc, errors);
  let scopes;
  let trimmedRanges;
  let scopeLabel;
  let masterSourceCount = 0;
  let masterInstanceCount = 0;
  let masterAccessible = false;
  if (selections) {
    const masterNodes = collectMasterTextNodes(doc);
    errors.push(...masterNodes.errors);
    masterSourceCount = masterNodes.nodes.length;
    masterAccessible = masterNodes.masterAccessible;
    const masterByStory = buildMasterStoryMap(masterNodes.nodes);
    const result = collectSelectionScopes(selections, errors, masterByStory);
    scopes = result.scopes;
    trimmedRanges = result.trimmed;
    scopeLabel = `选取项（${scopes.length} 处范围）`;
  } else {
    const collection = collectDocumentTextNodes(doc);
    errors.push(...collection.errors);
    if (!collection.nodes.length) {
      const message = '文档中没有可扫描的文本对象。';
      alert(errors.length ? `${message}\n${errors.join('\n')}` : message);
      return;
    }
    masterSourceCount = collection.nodes.filter(item => item.isMaster).length;
    masterAccessible = collection.masterAccessible;
    const masterByStory = buildMasterStoryMap(collection.nodes);
    const result = collectDocumentScopes(collection.nodes, errors, masterByStory);
    scopes = result.scopes;
    trimmedRanges = result.trimmed;
    masterInstanceCount = result.masterInstances;
    scopeLabel = `文档（${collection.nodes.length} 个文本对象）`;
  }

  if (!scopes.length) {
    const message = selections
      ? '选取项中没有可调整的文本字符。'
      : '文档中没有可扫描的文本对象。';
    alert(errors.length ? `${message}\n${errors.join('\n')}` : message);
    return;
  }

  const { targets, stats, routed, unmatched } = collectRegexTargets(scopes, errors);
  applyRegexTargets(doc, targets, errors, stats);
  const report = [
    `Affinity CJK Regex Tracking ${VERSION}`,
    `扫描范围：${scopeLabel}`,
  ];
  if (masterSourceCount || masterInstanceCount || routed) {
    report.push(
      `母版页源文本框：${masterSourceCount} 个；页面母版实例：${masterInstanceCount} 个；` +
      `经母版文本框写入 ${routed} 处、未匹配 ${unmatched} 处`
    );
  }
  if (masterInstanceCount && !masterAccessible) {
    report.push('提示：当前 SDK 无法枚举母版页，母版实例只能直接改写自身节点。');
  }
  if (trimmedRanges) {
    report.push(`Story 存在读取不到的字符，已按可读区间处理：${trimmedRanges} 个文本范围`);
  }
  for (const [ruleName, stat] of stats) {
    report.push(
      `${ruleName}（${formatTracking(stat.tracking)}）：` +
      `命中 ${stat.matches}，已是目标值 ${stat.skipped}，` +
      `成功设置 ${stat.applied}，失败 ${stat.failed}`
    );
  }
  report.push(
    `处理异常：${errors.length}`,
    ...errors.map(error => `• ${error}`)
  );
  console.log(report.join('\n'));
}

main();
