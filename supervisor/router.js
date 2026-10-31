// supervisor/router.js

/**
 * 根据书的当前状态，决定下一步动作
 * @param {object} state - readBookState() 的返回值
 * @returns {object} { action, step_id, reason }
 */
function decideNextAction(state) {
  // 优先级从高到低：大纲 → 人物 → 卷大纲 → 章节大纲 → 逐章起草 → 润色
  if (!state.has_outline) {
    return { action: 'run_step', step_id: '大纲', reason: '尚未生成大纲' };
  }
  if (!state.has_characters) {
    return { action: 'run_step', step_id: '人物', reason: '尚未生成人物设定' };
  }
  if (!state.has_volume_outline) {
    return { action: 'run_step', step_id: '卷大纲', reason: '尚未生成卷大纲' };
  }
  if (!state.has_chapter_outlines) {
    return { action: 'run_step', step_id: '章节大纲', reason: '尚未生成章节大纲' };
  }

  // 逐章处理：找到第一章“缺草稿或润色”的章节
  if (state.chapters.length === 0) {
    return { action: 'run_step', step_id: '章节', reason: '尚无任何章节草稿' };
  }

  for (const ch of state.chapters) {
    if (!ch.has_draft) {
      return { action: 'run_step', step_id: '章节', chapter: ch.index, reason: `第${ch.index}章缺草稿` };
    }
    if (!ch.has_polished) {
      return { action: 'run_step', step_id: '润色', chapter: ch.index, reason: `第${ch.index}章缺润色稿` };
    }
  }

  return { action: 'done', reason: '所有步骤均已完成' };
}

module.exports = { decideNextAction };