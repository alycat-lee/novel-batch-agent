# -*- coding: utf-8 -*-
r"""番茄小说作家后台「存草稿」发布器（Playwright 驱动真实浏览器）。

为什么必须驱动浏览器：番茄后台接口带 msToken + a_bogus（字节 webmssdk 签名），
headless 与裸 fetch 一律回 {"code":-3,"message":"登录信息有误"}；页面自身发出的
XHR 才会被签名。所以：读数据用「导航到目标页 + 抓 DOM / 捕获 XHR」，写数据用 UI。

用法：
  python fanqie_publish.py --proj <作品目录> --book-name <站点书名> --from 16 --to 30
  python fanqie_publish.py ... --dry                # 只打印计划，不开浏览器
  python fanqie_publish.py ... --existing 16=<itemId>   # 复用既有草稿（修标题）
  python fanqie_publish.py ... --polish             # 优先用「第NNN章-润色.md」

约定：
- 章节编号真源 = 文件名（第016章.md → 16）；正文首行标题只取「章名」。
  章名优先级：正文首行「第N章 名」→ chapter-outlines/第K卷.md 的第 M 个 ### 块 → 空。
- 站点标题 = 「第{编号}章 {章名}」：编号填 .serial-editor-title-left input，
  章名填 .serial-editor-input-hint-area（页面 DOM：<span>第</span><input><span>章</span><input 标题>）。
- 「存草稿」= 落进草稿箱（draft_list/v1），不出现在章节列表；重跑幂等（已有内容不重复粘贴）。
- 站点现状必须翻页读全（章节列表与草稿箱都是 15 条一页）。读到空要区分两种情况（2026-10-07 修）：
  页面出现空态文案（「暂无章节内容」/「暂无草稿」）且两 tab 都没有「第N章」行 ⇒ 站点确实为空，按新书继续发布；
  没有空态文案 ⇒ 视为页面没加载出来/未登录，fail-closed 中止（除非 --force），避免把已有章节重复发一遍。
- 只读现状：--state-only 打开浏览器读章节列表与草稿箱后打印 PUBLISH-STATE {json} 并退出（不写任何站点数据）。
- 删除草稿（UI 实测）：POST /api/author/delete_article/v1 带 book_id / item_id / is_draft=1。
  批量清理重复草稿（同章号保留最新一条）用工作区脚本 fanqie_draft_cleanup.py。
- stdout 末行固定输出 PUBLISH-RESULT {json} 供宿主解析；异常输出 PUBLISH-ERROR {json} + 退出码 2。
"""
import argparse, json, os, re, sys, time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

CN = "零〇一二三四五六七八九十百千两"
HEAD_RE = re.compile(r"^[ \t]*#{0,6}[ \t]*第[ \t]*([0-9０-９" + CN + r"]{1,6})[ \t]*章[ \t]*[:：、,.\-—_·]?[ \t]*([^\n]*)$")
NO_RE = re.compile(r"第\s*([0-9０-９" + CN + r"]{1,6})\s*章")
MANAGE = "https://fanqienovel.com/main/writer/chapter-manage/%s&%s?type=%d"
PUBLISH_NEW = "https://fanqienovel.com/main/writer/%s/publish/?enter_from=newchapter_1"
PUBLISH_ITEM = "https://fanqienovel.com/main/writer/%s/publish/%s"


def cn2int(s):
    s = s.strip().translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    if s.isdigit():
        return int(s)
    m = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    total = section = num = 0
    for ch in s:
        if ch in m:
            num = m[ch]
        elif ch == "十":
            section += (num or 1) * 10; num = 0
        elif ch == "百":
            section += (num or 1) * 100; num = 0
        elif ch == "千":
            section += (num or 1) * 1000; num = 0
    return total + section + num


class Pub:
    def __init__(self, a):
        self.a = a
        self.proj = os.path.abspath(a.proj)
        self.chdir = os.path.join(self.proj, "chapters")
        self.outdir = os.path.join(self.proj, "chapter-outlines")
        self.logf = open(a.log, "a", encoding="utf-8") if a.log else None

    def log(self, *parts):
        line = " ".join(str(p) for p in parts)
        if self.logf:
            self.logf.write(line + "\n"); self.logf.flush()
        print(line, flush=True)

    # ---------- 计划 ----------
    def outline_titles(self):
        out, gno = {}, 0
        if not os.path.isdir(self.outdir):
            return out
        vols = sorted([f for f in os.listdir(self.outdir) if f.endswith(".md") and "卷" in f and f[0] == "第"],
                      key=lambda f: int(re.search(r"(\d+)", f).group(1)))
        for vf in vols:
            for line in open(os.path.join(self.outdir, vf), encoding="utf-8").read().replace("\r\n", "\n").split("\n"):
                if line.startswith("#"):
                    m = HEAD_RE.match(line.strip())
                    if m:
                        gno += 1; out[gno] = m.group(2).strip()
        return out

    def chapter(self, no, titles, polish):
        for cand in ([os.path.join(self.chdir, "第%03d章-润色.md" % no), os.path.join(self.chdir, "第%03d章.md" % no)]
                     if polish else [os.path.join(self.chdir, "第%03d章.md" % no)]):
            if os.path.exists(cand):
                raw = open(cand, encoding="utf-8").read().replace("\r\n", "\n").strip()
                lines = raw.split("\n")
                name, body = "", raw
                m = HEAD_RE.match(lines[0].strip())
                if m:
                    name = m.group(2).strip(); body = "\n".join(lines[1:]).strip()
                if not name:
                    name = titles.get(no, "")
                name = re.sub(r"^#{1,6}[ \t]*", "", name).strip()
                return {"no": no, "name": name, "body": body, "path": os.path.basename(cand), "chars": len(body)}
        return None

    def plan(self):
        titles = self.outline_titles()
        out = []
        for no in range(self.a.frm, self.a.to + 1):
            ch = self.chapter(no, titles, self.a.polish)
            if ch is None:
                self.log("  plan %d: 无文件，跳过" % no); continue
            ch["title"] = ("第%d章 %s" % (no, ch["name"])).strip()
            out.append(ch)
            self.log("  plan %d title=%r chars=%d file=%s" % (no, ch["title"], ch["chars"], ch["path"]))
        return out

    # ---------- 站点现状 ----------
    # 站点有空态文案：没有内容时页面自己会写「暂无章节内容」/「共0篇草稿」「暂无草稿」。
    # 这是区分「站点确实为空」与「页面没加载出来」的唯一可靠信号（见 site_state）。
    EMPTY_HINTS = ("暂无章节内容", "暂无章节", "暂无草稿", "暂无内容", "还没有章节")
    # 站点列表都是 arco 表格 + 分页（章节目录/草稿箱都 15 条一页）。
    # 只读第一页会漏：>15 章的书会被当成「站点没有这些章」而重复发布 ⇒ 必须翻页。
    ROWS_JS = """() => Array.from(document.querySelectorAll('table tbody tr'))
        .map(tr => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)"""
    PAGES_JS = """() => { const ls = Array.from(document.querySelectorAll('.arco-pagination-item[aria-label]'))
        .map(e => e.getAttribute('aria-label'));
        const nums = ls.filter(x => /^第 \\d+ 页$/.test(x)).map(x => parseInt(x.replace(/[^0-9]/g, ''), 10));
        return nums.length ? Math.max.apply(null, nums) : 1; }"""
    PAGE_JS = """(i) => { const li = document.querySelector('.arco-pagination-item[aria-label="第 ' + i + ' 页"]'); if (li) li.click(); }"""

    def site_state(self, page, bid):
        """返回 {'chapters': {no: title}, 'drafts': [...], 'empty_confirmed': bool}：抓 DOM（不依赖 XHR 事件，更稳）。
        bid 必须由调用方传入：按书名匹配到书时 a.book_id 仍是空串，用它会导航到 /chapter-manage/&空 的空页。
        typ=1 章节列表，typ=2 草稿箱；两者都翻遍分页后再汇总。

        读到空有两种完全不同的原因，必须区分（2026-10-07 实测踩坑）：
          ① 站点确实没有章节/草稿 —— 页面自己会写空态文案「暂无章节内容」/「暂无草稿」；
          ② 页面没加载出来 / 未登录 / URL 变了 —— 读到的是空列表但**没有**空态文案。
        判据：本 tab 没有一行「第N章」且 body 出现空态文案 ⇒ 该 tab 确认为空；两个 tab 都确认
        ⇒ empty_confirmed=True，调用方可以安全按新书继续发布。否则维持 fail-closed（只有 --force 才继续），
        避免把站点已有章节重复发一遍。"""
        st = {"chapters": {}, "drafts": [], "max_no": 0, "empty": {}, "empty_confirmed": False}
        for typ in (1, 2):
            try:
                page.goto(MANAGE % (bid, quote(self.a.book_name), typ), wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                self.log("  site_state nav err type=%d: %s" % (typ, type(e).__name__)); continue
            time.sleep(7)
            try:
                npages = min(int(page.evaluate(self.PAGES_JS)), 20)
            except Exception:
                npages = 1
            rows, lines, body = [], [], ""
            for pi in range(1, npages + 1):
                if pi > 1:
                    try:
                        page.evaluate(self.PAGE_JS, pi)
                        time.sleep(3)
                    except Exception as e:
                        self.log("  site_state type=%d page %d click err: %s" % (typ, pi, e)); break
                try:
                    rows.extend(page.evaluate(self.ROWS_JS))
                except Exception as e:
                    self.log("  site_state type=%d rows err: %s" % (typ, e))
            try:
                body = page.inner_text("body")
            except Exception:
                body = ""
            if rows:      # 表格行优先（老口径）
                lines = rows
            else:         # 表格选择器不识（或页面确实没有表格）时退回整页文本
                lines = [l.strip() for l in body.split("\n") if l.strip()]
                self.log("  site type=%d: 表格无行，退回整页文本 %d 行" % (typ, len(lines)))
            hit = [t for t in self.EMPTY_HINTS if t in body]
            n_di = sum(1 for l in lines if NO_RE.search(l))
            # 行数日志分开打：过去把「退回整页文本的行数」当成 table rows 打印，误判过站点状态（rows=39 其实是侧栏文本）
            self.log("  site type=%d pages=%d table_rows=%d lines=%d di_lines=%d empty_hint=%s"
                     % (typ, npages, len(rows), len(lines), n_di, hit[0] if hit else "-"))
            for line in lines:
                m = NO_RE.search(line)
                if not m:
                    continue
                no = cn2int(m.group(1))
                if not (1 <= no <= 5000):
                    continue
                if typ == 1:
                    st["chapters"][no] = m.group(0)
                else:  # 草稿箱行形如「第16章 旧志有鬼 3641 1分钟前」
                    st["drafts"].append({"no": no, "line": line[:60]})
                st["max_no"] = max(st["max_no"], no)
            st["empty"][typ] = bool(hit) and n_di == 0
        # 两个 tab 都确认空 ⇒ 站点确实为空（不是没读出来）
        st["empty_confirmed"] = bool(st["empty"].get(1)) and bool(st["empty"].get(2))
        self.log("  site chapters: %s" % sorted(st["chapters"].keys()))
        self.log("  site drafts: %s" % json.dumps(st["drafts"], ensure_ascii=False))
        self.log("  site empty: %s confirmed=%s" % (json.dumps(st["empty"]), st["empty_confirmed"]))
        return st

    def find_book(self, page):
        if self.a.book_id:
            return self.a.book_id
        page.goto("https://fanqienovel.com/main/writer/book-manage", wait_until="domcontentloaded", timeout=90000)
        time.sleep(8)
        # 从「章节管理」链接里取 bookId&书名 的对应关系
        found = {}
        try:
            for h in page.eval_on_selector_all("a", "els => els.map(e => e.href || '')"):
                m = re.search(r"chapter-manage/(\d+)&([^?]+)", h)
                if m:
                    found[m.group(1)] = m.group(2)
        except Exception:
            pass
        for bid, raw in found.items():
            name = raw
            try:
                from urllib.parse import unquote
                name = unquote(raw)
            except Exception:
                pass
            if name.strip() == self.a.book_name.strip():
                self.log("  匹配到同名书目: %s -> %s" % (name, bid))
                return bid
        self.log("  站点未找到同名书目 %r（已有：%s）" % (self.a.book_name, list(found.values())))
        return ""

    # ---------- 执行 ----------
    def run(self):
        a = self.a
        self.log("=" * 74)
        self.log(time.strftime("%Y-%m-%d %H:%M:%S"), "publish start %s.%d..%d dry=%s polish=%s" % (a.book_name, a.frm, a.to, a.dry, a.polish))
        tasks = self.plan()
        report = {"book": a.book_name, "book_id": a.book_id, "ran_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                  "dry": bool(a.dry), "items": []}
        if a.dry:
            report["planned"] = [{"no": c["no"], "title": c["title"], "chars": c["chars"], "file": c["path"]} for c in tasks]
            self._save(report)
            self.log("DRY RUN: %d chapters planned" % len(tasks))
            return report
        existing = {}
        for s in a.existing or []:
            k, v = s.split("="); existing[int(k)] = v
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(a.profile, headless=False, locale="zh-CN",
                                                      viewport={"width": 1500, "height": 950},
                                                      args=["--disable-blink-features=AutomationControlled"])
            try:
                page = ctx.new_page()
                bid = self.find_book(page)
                if not bid:
                    raise RuntimeError("未找到同名书目：%s（先建书或核对 --book-name）" % a.book_name)
                report["book_id"] = bid
                st = self.site_state(page, bid)
                if a.state_only:
                    print("PUBLISH-STATE " + json.dumps({"book_id": bid, "chapters": sorted(st["chapters"].keys()),
                        "drafts": st["drafts"], "empty": st["empty"], "empty_confirmed": st["empty_confirmed"]}, ensure_ascii=False), flush=True)
                    return report
                if not st["chapters"] and not st["drafts"] and not st["empty_confirmed"] and not a.force:
                    raise RuntimeError("站点章节列表与草稿箱都读为空，且页面没有出现空态文案（可能未登录、页面没加载出来，或 URL 不对）；为避免把已有章节重复发一遍，已中止。确认站点确实为空时加 --force 继续")
                if not st["chapters"] and not st["drafts"] and st["empty_confirmed"]:
                    self.log("  站点确认为空（两页都出现空态文案且无「第N章」行），按新书发布")
                for ch in tasks:
                    no, name = ch["no"], ch["name"]
                    rec = {"no": no, "name": name, "title": ch["title"], "chars": ch["chars"], "file": ch["path"]}
                    item = existing.get(no)
                    if no in st["chapters"] and item is None and not a.force:
                        rec["status"] = "already_on_site"; rec["site_title"] = st["chapters"][no]
                        self.log("  SKIP %d: 站点已有《%s》" % (no, rec["site_title"])); report["items"].append(rec); continue
                    if item is None and any(d["no"] == no for d in st["drafts"]):
                        rec["status"] = "draft_exists"
                        self.log("  注意 %d: 草稿箱已有同编号草稿（%s），跳过以免重复" % (no, [d["line"] for d in st["drafts"] if d["no"] == no][0]))
                        report["items"].append(rec); continue
                    try:
                        if item:
                            page.goto(PUBLISH_ITEM % (bid, item), wait_until="domcontentloaded", timeout=90000)
                        else:
                            page.goto(PUBLISH_NEW % bid, wait_until="domcontentloaded", timeout=90000)
                            page.wait_for_url(re.compile(r"/publish/\d+"), timeout=45000)
                            mm = re.search(r"/publish/(\d+)", page.url); item = mm.group(1) if mm else None
                        page.wait_for_selector(".ProseMirror", timeout=45000)
                        time.sleep(4)
                        rec["item_id"] = item
                        page.fill(".serial-editor-title-left input", str(no))
                        page.fill(".serial-editor-input-hint-area", name)
                        time.sleep(1)
                        cur = page.evaluate("() => (document.querySelector('.ProseMirror').innerText || '').length")
                        if cur < 300:
                            page.click(".ProseMirror")
                            page.evaluate("""(text) => {
                              const el = document.querySelector('.ProseMirror'); el.focus();
                              const dt = new DataTransfer(); dt.setData('text/plain', text);
                              el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
                            }""", ch["body"])
                            time.sleep(2); rec["pasted"] = True
                        else:
                            rec["pasted"] = False
                        rec["editor_chars"] = page.evaluate("() => (document.querySelector('.ProseMirror').innerText || '').length")
                        page.click("button:has-text('存草稿')", timeout=15000)
                        deadline, saved = time.time() + a.save_wait, False
                        while time.time() < deadline:
                            time.sleep(1)
                            try:
                                if "已保存到云端" in page.inner_text("body") or "保存成功" in page.inner_text("body"):
                                    saved = True
                            except Exception:
                                pass
                        rec["saved"] = saved
                        rec["status"] = "draft_saved" if saved else "save_unconfirmed"
                    except Exception as e:
                        rec["status"] = "error"; rec["error"] = "%s: %s" % (type(e).__name__, str(e)[:200])
                    self.log("  -> %s" % json.dumps({k: rec.get(k) for k in ("no", "item_id", "title", "editor_chars", "saved", "status", "error")}, ensure_ascii=False))
                    report["items"].append(rec)
                    time.sleep(3)
                orphans = [i["item_id"] for i in report["items"] if i.get("status") in ("error", "save_unconfirmed") and i.get("item_id")]
                report["orphan_drafts"] = orphans
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
        self._save(report)
        ok = sum(1 for i in report["items"] if i.get("status") == "draft_saved")
        self.log("RESULT saved=%d/%d" % (ok, len(report["items"])))
        return report

    def _save(self, report):
        if self.a.report:
            json.dump(report, open(self.a.report, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def main():
    # Windows 下 stdout 是管道时 Python 默认用本地代码页（cp936）编码，宿主按 UTF-8 解码会得到乱码。
    # 显式把 stdout/stderr 钉死成 UTF-8；宿主侧另有 GBK 兜底解码（lib/index.js 的 decodeChildOutput）。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--proj", required=True, help="作品目录（含 chapters/ 与 chapter-outlines/）")
    ap.add_argument("--book-name", default="", help="站点书名（默认取作品目录名）")
    ap.add_argument("--book-id", default="", help="站点 book_id（留空则按书名匹配）")
    ap.add_argument("--profile", default="", help="Playwright 持久化登录 profile 目录")
    ap.add_argument("--from", dest="frm", type=int, required=True)
    ap.add_argument("--to", dest="to", type=int, required=True)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--polish", action="store_true")
    ap.add_argument("--force", action="store_true", help="站点已有同编号也发（默认跳过）")
    ap.add_argument("--state-only", dest="state_only", action="store_true",
                    help="只读站点现状（章节/草稿/是否确认为空）后退出，不开新章、不点存草稿")
    ap.add_argument("--existing", action="append", default=[], help="no=itemId 复用既有草稿")
    ap.add_argument("--save-wait", type=float, default=9.0)
    ap.add_argument("--log", default="")
    ap.add_argument("--report", default="")
    a = ap.parse_args()
    if not a.book_name:
        a.book_name = os.path.basename(os.path.abspath(a.proj))
    if not a.dry and not a.profile:
        print("PUBLISH-ERROR " + json.dumps({"error": "缺少 --profile（登录态目录）"}, ensure_ascii=False), flush=True)
        sys.exit(2)
    p = Pub(a)
    try:
        report = p.run()
    except Exception as e:
        p.log("ERROR %s: %s" % (type(e).__name__, str(e)[:300]))
        print("PUBLISH-ERROR " + json.dumps({"error": "%s: %s" % (type(e).__name__, str(e)[:300])}, ensure_ascii=False), flush=True)
        sys.exit(2)
    p.log("PUBLISH DONE")
    print("PUBLISH-RESULT " + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
