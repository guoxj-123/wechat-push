#!/usr/bin/env python3
"""通过 wb-push.js 分段推送长文本到微信（ClawBot / iLink 通道）。

为什么需要它：wb-push.js 的 --send 模式内部会把正文 truncate 到 1500 字符，
直接喂长文本会被静默截断，且不报错。本脚本负责切段 + 逐段调用 + 限流间隔。

用法:
    python wb-push-long.py <文件路径> [--title "标题"] [--max 1400] [--gap 2]

参数:
    file    待推送的文本文件（UTF-8）
    --title 标题；省略时取文件第一行
    --max   每段最大字符数，默认 1400（wb-push.js 上限 1500，留余量）
    --gap   段之间的间隔秒数，默认 2（iLink 限额约 7 条/5 分钟）

示例:
    python wb-push-long.py "report.md" --title "日报"
    python wb-push-long.py "/path/to/长文.md" --title "标题"
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUSH_JS = os.path.join(SKILL_DIR, "scripts", "wb-push.js")


def _managed_node_candidates():
    """扫描 WorkBuddy 托管 node 目录，返回所有 node 可执行文件路径。

    不写死版本号——托管目录形如
    ~/.workbuddy/binaries/node/versions/<版本号>/node.exe，
    版本号随 WorkBuddy 升级而变，写死会让其他用户直接落到回退分支甚至失败。
    """
    home = os.path.expanduser("~")
    versions_dir = os.path.join(home, ".workbuddy", "binaries", "node", "versions")
    found = []
    try:
        for name in os.listdir(versions_dir):
            for exe in ("node.exe", "node"):
                p = os.path.join(versions_dir, name, exe)
                if os.path.exists(p):
                    found.append(p)
    except OSError:
        pass
    # 版本号降序，优先取最新版
    found.sort(key=lambda p: os.path.basename(os.path.dirname(p)), reverse=True)
    return found


def find_node():
    """优先用 WorkBuddy 托管的 node（自动探测版本），回退到 PATH 中的 node。"""
    candidates = _managed_node_candidates()
    for n in ("node", "node.exe"):
        p = shutil.which(n)
        if p and p not in candidates:
            candidates.append(p)
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit(
        "找不到 node，无法调用 wb-push.js。"
        "请在 WorkBuddy 对话内执行，或自行安装 Node.js 18+ 并加入 PATH。"
    )


# 条目起始行：有序列表 "1. xxx" / "1、xxx" / 无序 "- xxx" / "• xxx"
ITEM_START_RE = re.compile(r"^\s*(?:\d+\s*[.、)]|[-*•])\s+")


def _split_items_into_blocks(text, maxlen):
    """条目感知切分：条目为原子单位，绝不从条目内部截断。

    规则：
      1. 逐行扫描；遇到条目起始行（`1. ` / `- ` 等）则开启新条目，
         其后的续行（缩进或不以标记开头）归入当前条目。
      2. 非条目行（标题、普通段落）各自成为独立块。
      3. 贪心合并块到每段 <= maxlen；放不下就把**整个块**移到下一段。
      4. 仅当单个块自身超长（罕见：一条资讯长达上千字）时，
         才按句号边界拆该块，并打上续接标记，明确告知读者这是同一条的延续。
    """
    lines = text.splitlines()
    blocks = []          # [(kind, content)]，kind 为 'item' 或 'plain'
    cur, cur_kind = [], None

    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            # 空行：结束当前块
            if cur:
                blocks.append((cur_kind, "\n".join(cur).strip()))
                cur, cur_kind = [], None
            continue
        is_item = bool(ITEM_START_RE.match(ln))
        if is_item:
            if cur:
                blocks.append((cur_kind, "\n".join(cur).strip()))
            cur, cur_kind = [ln], "item"
        else:
            if cur_kind == "item":
                cur.append(ln)          # 条目续行
            elif cur:
                cur.append(ln)
            else:
                cur, cur_kind = [ln], "plain"
    if cur:
        blocks.append((cur_kind, "\n".join(cur).strip()))

    # 块内超长才降级拆分（打续接标记，避免读者误以为是新条目或新消息）
    normalized = []
    for kind, blk in blocks:
        if len(blk) <= maxlen:
            normalized.append((kind, blk, False))
            continue
        rest, first = blk, True
        while len(rest) > maxlen:
            cut = rest.rfind("。", 0, maxlen)
            if cut < maxlen * 0.5:
                cut = rest.rfind("\n", 0, maxlen)
            if cut < maxlen * 0.5:
                cut = maxlen
            else:
                cut += 1
            normalized.append((kind, rest[:cut].strip(), not first))
            rest = rest[cut:].strip()
            first = False
        if rest:
            normalized.append((kind, rest, not first))

    # 小标题单独成块会白白浪费一段，把它吸附到紧邻的下一块头部；
    # 但吸附后若超过 maxlen，则放弃吸附（宁可标题单独成段，也不超限）。
    merged = []
    for kind, blk, is_cont in normalized:
        if (merged and merged[-1][2] is False and _is_heading(merged[-1][1])
                and len(merged[-1][1]) + 1 + len(blk) <= maxlen):
            k0, b0, c0 = merged.pop()
            merged.append((kind, b0 + "\n" + blk, is_cont))
        else:
            merged.append((kind, blk, is_cont))

    groups, cur_group, cur_len = [], [], 0
    for kind, blk, is_cont in merged:
        # 兜底：块自身仍超限（吸附合并可能导致），按句号边界再拆一次，
        # 避免整段突破 wb-push.js 的 1500 字符硬上限被静默截断。
        pieces = _hard_split(blk, maxlen) if len(blk) > maxlen else [blk]
        for pi, piece in enumerate(pieces):
            if is_cont or pi > 0:
                piece = "（接上条）" + piece
            add = len(piece) + (2 if cur_group else 0)
            if cur_group and cur_len + add > maxlen:
                groups.append("\n\n".join(cur_group))
                cur_group, cur_len = [piece], len(piece)
            else:
                cur_group.append(piece)
                cur_len += add
    if cur_group:
        groups.append("\n\n".join(cur_group))
    return groups


def _hard_split(blk, maxlen):
    """按句号/换行边界把超长块拆成 <=maxlen 的若干片（最后兜底才硬切）。"""
    pieces, rest = [], blk
    while len(rest) > maxlen:
        cut = rest.rfind("。", 0, maxlen)
        if cut < maxlen * 0.5:
            cut = rest.rfind("\n", 0, maxlen)
        if cut < maxlen * 0.5:
            cut = maxlen
        else:
            cut += 1
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return pieces


def _is_heading(line):
    """是否为 Markdown 小标题（仅认 # 开头的行，避免误吸普通短行）。"""
    return line.strip().startswith("#")


def split_text(text, maxlen):
    """分段入口：条目感知切分（条目为原子单位，不夹断）。"""
    return _split_items_into_blocks(text, maxlen)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--title", default="")
    ap.add_argument("--max", type=int, default=1400)
    ap.add_argument("--gap", type=float, default=2)
    args = ap.parse_args()

    if not os.path.exists(args.file):
        sys.exit("文件不存在: " + args.file)
    if not os.path.exists(PUSH_JS):
        sys.exit("找不到 wb-push.js: " + PUSH_JS)

    text = open(args.file, encoding="utf-8").read().strip()
    if not text:
        sys.exit("文件内容为空")

    lines = text.splitlines()
    first = lines[0].strip() if lines else ""
    if args.title:
        # 显式给了标题：若正文首行是摘要/标题性质的短行（非列表、非 # 标题），
        # 视为与消息标题重复，从正文中剥离，避免「标题 + 正文首行摘要」双份。
        title = args.title
        body = text
        if first and not _is_heading(first) and not ITEM_START_RE.match(first) and len(first) <= 80:
            body = text[len(lines[0]):].strip() or text
    else:
        # 未给标题：取正文首行作标题，并从正文中剥离该行。
        title = first or "WorkBuddy 通知"
        body = text[len(lines[0]):].strip() if lines else text
        if not body:
            body = text

    groups = split_text(body, args.max)
    total = len(groups)
    print(f"[wb-push-long] 共 {total} 段，长度 {[len(g) for g in groups]}")

    node = find_node()
    env = dict(os.environ)
    for i, g in enumerate(groups, 1):
        seg_title = f"{title} ({i}/{total})" if total > 1 else title
        proc = subprocess.run(
            [node, PUSH_JS, "--send", seg_title],
            input=g.encode("utf-8"),
            capture_output=True,
            env=env,
        )
        out = (proc.stdout + proc.stderr).decode("utf-8", "replace").strip()
        print(f"--- 第 {i}/{total} 段 rc={proc.returncode}\n{out}")
        if proc.returncode != 0:
            sys.exit(1)
        if i < total:
            time.sleep(args.gap)

    print("[wb-push-long] 全部发送完成")


if __name__ == "__main__":
    main()
