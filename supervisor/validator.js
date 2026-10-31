// supervisor/validator.js
const fs = require('fs');
const path = require('path');

/**
 * 验收一次步骤执行的产出
 * @param {string} bookDir - 书的根目录
 * @param {object} action - router 返回的 action 对象
 * @returns {object} { passed: boolean, reason: string }
 */
function validateOutput(bookDir, action) {
  const stepId = action.step_id;

  // 1. 基础检查：对应目录下是否有非空文件
  const dirMap = {
    '大纲': path.join(bookDir, 'steps'),
    '人物': path.join(bookDir, 'steps'),
    '卷大纲': path.join(bookDir, 'steps'),
    '章节大纲': path.join(bookDir, 'chapter-outlines'),
    '章节': path.join(bookDir, 'chapters'),
    '润色': path.join(bookDir, 'chapters'),
  };

  const targetDir = dirMap[stepId];
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { passed: false, reason: `目标目录不存在: ${targetDir}` };
  }

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
  if (files.length === 0) {
    return { passed: false, reason: '没有生成任何 .md 文件' };
  }

  // 2. 针对具体步骤的额外检查
  if (stepId === '大纲') {
    const outlineFile = files.find(f => f.includes('大纲'));
    if (!outlineFile) return { passed: false, reason: '未找到大纲文件' };
    const content = fs.readFileSync(path.join(targetDir, outlineFile), 'utf8');
    if (content.length < 100) return { passed: false, reason: '大纲内容过短（<100字）' };
  }

  if (stepId === '章节' && action.chapter) {
    const chFile = files.find(f => f.includes(`第${action.chapter}章`) && !f.includes('润色'));
    if (!chFile) return { passed: false, reason: `未找到第${action.chapter}章草稿` };
    const content = fs.readFileSync(path.join(targetDir, chFile), 'utf8');
    if (content.length < 500) return { passed: false, reason: `第${action.chapter}章内容过短（<500字）` };
  }

  return { passed: true, reason: '验收通过' };
}

module.exports = { validateOutput };