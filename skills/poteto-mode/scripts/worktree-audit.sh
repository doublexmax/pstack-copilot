#!/usr/bin/env bash
# Read-only. Never deletes; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [repo-path]   (defaults to the current repo)
set -u

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

# Main worktree is the first entry.
main_wt=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)

# Resolve trunk from origin/HEAD so this works on repos that use master.
# Fetch is best-effort; stale is fine for a first pass.
trunk=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
trunk=${trunk#origin/}
[ -z "$trunk" ] && trunk=master
git fetch origin "$trunk" --quiet 2>/dev/null || echo "warn: could not fetch origin/$trunk; merged column may be stale" >&2

# PR state by branch, fetched once as TSV so az does the filtering and this
# script needs no jq. az reports refs as refs/heads/<branch>; the lookup below
# matches that form directly.
prs=$(mktemp)
trap 'rm -f "$prs"' EXIT INT TERM
az repos pr list --status all --top 1000 \
	--query "[].[sourceRefName, pullRequestId, status]" -o tsv 2>/dev/null \
	> "$prs" || : > "$prs"
# az caps the result set, so on a busy repo the completed and abandoned PRs
# can eat the budget and push a live PR out of view.
[ "$(wc -l < "$prs" 2>/dev/null || echo 0)" -ge 1000 ] && {
	echo "warn: the PR list hit the 1000-row cap, so older PRs are invisible" >&2
	echo "      and a branch whose PR fell outside the window looks PR-less." >&2
}
# An empty PR table is not cosmetic: it disables the open-PR guard, which is
# the check that keeps a worktree with live review work out of the safe bucket.
[ -s "$prs" ] && have_prs=yes || {
	have_prs=no
	echo "warn: no PR data from az, so the open-PR guard is INACTIVE." >&2
	echo "      Treat every 'safe' row as 'review' until you confirm by hand." >&2
}

sessions_db="$HOME/.copilot/session-store.db"
if [ -f "$sessions_db" ] && ! command -v sqlite3 >/dev/null 2>&1; then
	echo "warn: sqlite3 not found; LAST_CHAT is blank and recent work will not" >&2
	echo "      hold a worktree back from the safe bucket." >&2
fi

# du walks every file, which costs minutes per worktree on a large monorepo.
skip_size="${PSTACK_AUDIT_SKIP_SIZE:-0}"
[ "$skip_size" = 1 ] || echo "note: measuring sizes with du; set PSTACK_AUDIT_SKIP_SIZE=1 to skip" >&2

now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	if [ "$skip_size" = 1 ]; then size="-"; else size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}'); fi
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of trunk, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" "origin/$trunk" 2>/dev/null && merged=YES || merged=no

	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null); st=$?
	if [ $st -ne 0 ]; then dirty=unknown
	elif [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	# A branch can carry several PRs, and az does not promise an order, so an
	# abandoned row must never shadow a live one. Scan all rows, prefer active.
	pr=$([ -n "$branch" ] && awk -F'\t' -v b="refs/heads/$branch" '
		{ ref=$1; id=$2; status=tolower($3) }
		ref==b { if (status=="active") { print "#" id "/active"; found=1; exit }
		         last="#" id "/" status }
		END { if (!found && last) print last }' "$prs" 2>/dev/null)
	[ -z "$pr" ] && pr="-"

	# Most recent session whose cwd was this worktree, matched exactly so
	# glint-482 does not match glint-482-r37. git worktree list emits
	# C:/Users/..., the session store holds C:\Users\..., so comparing them raw
	# never matches and the busiest worktree reads as untouched. Normalize
	# separators and case on both sides. Single quotes are doubled because a
	# branch name may legally contain one.
	last="-"; last_ts=0
	if [ -f "$sessions_db" ] && command -v sqlite3 >/dev/null 2>&1; then
		wt_sql=$(printf '%s' "$wt" | tr '\\' '/' | sed "s/'/''/g")
		last=$(sqlite3 "file:${sessions_db}?mode=ro" \
			"SELECT substr(max(updated_at),1,10) FROM sessions
			 WHERE lower(replace(cwd,'\','/')) = lower('$wt_sql');" 2>/dev/null)
		[ -z "$last" ] && last="-"
		[ "$last" != "-" ] && last_ts=$(date -j -f '%Y-%m-%d' "$last" '+%s' 2>/dev/null \
			|| date -d "$last" '+%s' 2>/dev/null || echo 0)
	fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	case "$pr" in
		*/completed|*/abandoned) terminal=yes ;;
		*) terminal=no ;;
	esac
	case "$dirty" in wip:*|unknown) bucket=hold-wip ;; *)
		case "$pr" in */active) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-chat
			elif [ "$have_prs" = no ]; then bucket=review
			elif [ "$merged" = YES ] || [ "$terminal" = yes ]; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

