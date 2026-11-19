// Affinity CJK Regex Tracking
// Version: 0.6.0
// Apply 125‰ Tracking to regex-matched CJK/Latin boundary characters.
// Target: Affinity by Canva desktop scripting API (SDK 3.3.x)
// License: MIT

'use strict';

const { Document } = require('/document.js');
const { GlyphAttDoubleType } = require('/glyphatts.js');
const { Selection, TextSelection } = require('/selections.js');
const { StoryDelta } = require('/storydelta.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { StoryRange } = require('affinity:story');

const VERSION = '0.6.0';
const TRACKING = 0.125;

const REGEXES = [
  /[ぁ-ゖァ-ー\u32FF㍻-㍾\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF](?=[0-9A-Za-z])/gu,
  /[0-9A-Za-z](?=[ぁ-ゖァ-ー\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/gu,
];

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function storyIdentity(story) {
  return story && story.handle !== undefined ? story.handle : story;
}

function nodeIdentity(node) {
  return node && node.handle !== undefined ? node.handle : node;
}

function getStoryText(story) {
  if (typeof story.text === 'string') return story.text;
  if (typeof story.getLength !== 'function' || typeof story.getText !== 'function') {
    throw new Error('Story 未返回可读取的文本字符串。');
  }
  const length = story.getLength();
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`Story 返回了无效文本长度：${length}。`);
  }
  const text = story.getText(0, length);
  if (typeof text !== 'string' || text.length !== length) {
    throw new Error('Story.getText 返回的文本长度不匹配。');
  }
  return text;
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

    const rangeLength = end - range.begin;
    try {
      const text = story.getText(range.begin, rangeLength);
      if (typeof text === 'string' && text.length === rangeLength) {
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
          end,
          text,
          selectionNode,
          fallbackNode,
        };
      }
      failures.push(
        `Story.getText 长度不匹配（应为 ${rangeLength}，实际为 ${text?.length ?? '无效'}）`
      );
    } catch (error) {
      failures.push(`StoryRange 读取失败：${errorMessage(error)}`);
    }

    try {
      const fullText = getStoryText(story);
      if (fullText.length >= end) {
        const text = fullText.slice(range.begin, end);
        if (text.length === rangeLength) {
          return {
            story,
            begin: range.begin,
            end,
            text,
            selectionNode,
            fallbackNode: null,
          };
        }
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

function collectDocumentTextNodes(doc) {
  const roots = [];
  const errors = [];
  for (const [collectionName, label, optional] of [
    ['spreads', '页面', false],
    ['masterSpreads', '母版页', true],
  ]) {
    try {
      const collection = doc[collectionName];
      if (optional && (collection === undefined || collection === null)) continue;
      if (!collection || typeof collection.toArray !== 'function') {
        throw new Error('SDK 未返回有效节点集合。');
      }
      for (const node of collection.toArray()) roots.push({ node, label });
    } catch (error) {
      errors.push(`读取${label}列表失败：${errorMessage(error)}`);
    }
  }

  const nodes = [];
  const visited = new Set();
  for (let cursor = 0; cursor < roots.length; cursor++) {
    const { node, label } = roots[cursor];
    if (!node) continue;
    const identity = nodeIdentity(node);
    if (visited.has(identity)) continue;
    visited.add(identity);

    try {
      if (node.isTextNode) nodes.push({ node, label: `${label}文本对象 ${nodes.length + 1}` });
    } catch (error) {
      errors.push(`读取文本节点属性失败：${errorMessage(error)}`);
    }

    try {
      const children = node.children;
      if (children && typeof children.toArray === 'function') {
        for (const child of children.toArray()) roots.push({ node: child, label });
      } else if (children) {
        throw new Error('SDK 未返回有效子节点集合。');
      }
    } catch (error) {
      errors.push(`读取节点子项失败：${errorMessage(error)}`);
    }
  }
  return { nodes, errors };
}

function collectRegexTargets(nodes, errors) {
  const targets = [];
  const seen = new Map();
  let matchCount = 0;
  let alreadyAppliedCount = 0;

  for (const item of nodes) {
    try {
      const range = getNodeStoryText(item.node);
      for (const regex of REGEXES) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(range.text)) !== null) {
          const begin = range.begin + match.index;
          const end = begin + match[0].length;
          let storyTargets = seen.get(storyIdentity(range.story));
          if (!storyTargets) {
            storyTargets = new Set();
            seen.set(storyIdentity(range.story), storyTargets);
          }
          const key = `${begin}:${end}`;
          if (storyTargets.has(key)) continue;
          storyTargets.add(key);
          matchCount++;

          const actualText = range.story.getText(begin, end - begin);
          if (actualText !== match[0]) {
            errors.push(
              `${item.label}，索引 ${begin}：正则命中“${match[0]}”，` +
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
            if (currentTracking === TRACKING) {
              alreadyAppliedCount++;
              continue;
            }
          } catch (error) {
            errors.push(
              `${item.label}，索引 ${begin} “${match[0]}”无法读取 Tracking：` +
              `${errorMessage(error)}`
            );
            continue;
          }

          targets.push({
            node: range.selectionNode,
            fallbackNode: range.fallbackNode,
            story: range.story,
            begin,
            end,
            sample: match[0],
            label: item.label,
          });
        }
      }
    } catch (error) {
      errors.push(`${item.label}：${errorMessage(error)}`);
    }
  }
  return { targets, matchCount, alreadyAppliedCount };
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
      TRACKING
    )
  );
}

function executeTarget(doc, target) {
  try {
    doc.executeCommand(createFormattingCommand(doc, target, target.node));
    return;
  } catch (primaryError) {
    if (!target.fallbackNode ||
        nodeIdentity(target.fallbackNode) === nodeIdentity(target.node)) {
      throw primaryError;
    }
    try {
      doc.executeCommand(
        createFormattingCommand(doc, target, target.fallbackNode)
      );
    } catch (fallbackError) {
      throw new Error(
        `文档节点失败：${errorMessage(primaryError)}；` +
        `StoryInterface 节点失败：${errorMessage(fallbackError)}`
      );
    }
  }
}

function applyRegexTargets(doc, targets, errors) {
  const groups = new Map();
  for (const target of targets) {
    const identity = nodeIdentity(target.node);
    let group = groups.get(identity);
    if (!group) {
      group = { label: target.label, targets: [] };
      groups.set(identity, group);
    }
    group.targets.push(target);
  }

  let appliedCount = 0;
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
        errors.push(
          `${target.label}，索引 ${target.begin} “${target.sample}”：` +
          `${errorMessage(error)}`
        );
      }
    }
    if (!validTargets.length) continue;

    try {
      doc.executeCommand(builder.createCommand());
      appliedCount += validTargets.length;
    } catch (batchError) {
      errors.push(
        `${group.label}批量调整失败，改为逐个正则匹配项重试：` +
        `${errorMessage(batchError)}`
      );
      for (const target of validTargets) {
        try {
          executeTarget(doc, target);
          appliedCount++;
        } catch (error) {
          errors.push(
            `${target.label}，索引 ${target.begin} “${target.sample}”：` +
            `${errorMessage(error)}`
          );
        }
      }
    }
  }
  return appliedCount;
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

  const collection = collectDocumentTextNodes(doc);
  const errors = [...collection.errors];
  if (!collection.nodes.length) {
    const message = '文档中没有可扫描的文本对象。';
    alert(errors.length ? `${message}\n${errors.join('\n')}` : message);
    return;
  }

  const { targets, matchCount, alreadyAppliedCount } =
    collectRegexTargets(collection.nodes, errors);
  const appliedCount = applyRegexTargets(doc, targets, errors);
  const report = [
    `Affinity CJK Regex Tracking ${VERSION}`,
    `扫描文本对象：${collection.nodes.length}`,
    `正则命中：${matchCount}`,
    `已是 125‰：${alreadyAppliedCount}`,
    `成功设置 Tracking：${appliedCount}`,
    `处理异常：${errors.length}`,
    ...errors.map(error => `• ${error}`),
  ];
  console.log(report.join('\n'));
}

main();
