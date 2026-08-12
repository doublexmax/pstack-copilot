#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [repo-path]   (defaults to the current repo)
set -u

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')

# Trunk drives the merge check. Resolve it from origin/HEAD so this works on
# repos that use master. Fetch is best-effort; stale is fine for a first pass.
trunk=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
trunk=${trunk#origin/}
[ -z "$trunk" ] && trunk=master
git fetch origin "$trunk" --quiet 2>/dev/null || echo "warn: could not fetch origin/$trunk; merged column may be stale" >&2

# PR state by branch, fetched once as TSV so az does the filtering and this
# script needs no jq. az reports refs as refs/heads/<branch>; the lookup below
# matches that form directly. Columns: ref, id, status.
prs=$(mktemp)
az repos pr list --status all --top 1000 \
	--query "[].[sourceRefName, pullRequestId, status]" -o tsv 2>/dev/null \
	> "$prs" || : > "$prs"
# An empty PR table is not cosmetic: it disables the open-PR guard, which is
# the check that keeps a worktree with live review work out of the safe bucket.
[ -s "$prs" ] && have_prs=yes || {
	have_prs=no
	echo "warn: no PR data from az, so the open-PR guard is INACTIVE." >&2
	echo "      Treat every 'safe' row as 'review' until you confirm by hand." >&2
}

# Copilot's local session store, read with sqlite3. Without it the last-chat
# column is blank, so a worktree you used this morning looks abandoned.
sessions_db="$HOME/.copilot/session-store.db"
if [ -f "$sessions_db" ] && ! command -v sqlite3 >/dev/null 2>&1; then
	echo "warn: sqlite3 not found; LAST_CHAT is blank and recent work will not" >&2
	echo "      hold a worktree back from the safe bucket." >&2
fi

# du walks every file, which costs minutes per worktree on a large monorepo.
# Set PSTACK_AUDIT_SKIP_SIZE=1 to get the merge/PR/chat signals immediately.
skip_size="${PSTACK_AUDIT_SKIP_SIZE:-0}"
[ "$skip_size" = 1 ] || echo "note: measuring sizes with du; set PSTACK_AUDIT_SKIP_SIZE=1 to skip" >&2

now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	if [ "$skip_size" = 1 ]; then size="-"; else size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}'); fi
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of trunk, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" "origin/$trunk" 2>/dev/null && merged=YES || merged=no

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
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

	pr=$([ -n "$branch" ] && awk -F'\t' -v b="refs/heads/$branch" \
		'$1==b {print "#" $2 "/" $3; exit}' "$prs" 2>/dev/null)
	[ -z "$pr" ] && pr="-"

	# Most recent session whose cwd was this worktree. Exact match on cwd, so
	# glint-482 does not match glint-482-r37.
	last="-"; last_ts=0
	if [ -f "$sessions_db" ] && command -v sqlite3 >/dev/null 2>&1; then
		last=$(sqlite3 "file:${sessions_db}?mode=ro" \
			"SELECT substr(max(updated_at),1,10) FROM sessions WHERE cwd = '$wt';" 2>/dev/null)
		[ -z "$last" ] && last="-"
		[ "$last" != "-" ] && last_ts=$(date -j -f '%Y-%m-%d' "$last" '+%s' 2>/dev/null \
			|| date -d "$last" '+%s' 2>/dev/null || echo 0)
	fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	case "$dirty" in wip:*) bucket=hold-wip ;; *)
		case "$pr" in */active) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-chat
			elif [ "$have_prs" = no ]; then bucket=review
			elif [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

rm -f "$prs"
