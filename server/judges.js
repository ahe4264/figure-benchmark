/**
 * judges.js — the filesystem half of the judge registry.
 *
 * The registry itself is in src/lib/judges.js, because the browser needs it too:
 * a deployed read-only build resolves the same per-judge layout over HTTP. This
 * module adds the one thing that only makes sense on a server — the absolute
 * directory a judge's pair files live in — and re-exports the rest so that
 * server code has a single import to reach for.
 *
 * It is the single source of the routing rule. server/pairwise_evaluator.js,
 * server/api.js and server/schedule_cli.js all resolve through resultsDirFor(),
 * so the three cannot drift into disagreeing about where a run's results went.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { subdirFor, HUMAN_SUBDIR } from '../src/lib/judges.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const RESULTS_ROOT = path.resolve(__dirname, '..', 'benchmark_results')

export {
  JUDGES, DEFAULT_JUDGE, availableJudges, judgeFor, subdirFor, staticPrefixFor,
  HUMAN_SUBDIR, HUMAN_STATIC_PREFIX,
  rankingSources, isHumanSource, rankingSourceFor,
} from '../src/lib/judges.js'

/**
 * Absolute path to the directory holding this judge's pair files.
 *
 * Always a subdirectory: no judge owns RESULTS_ROOT, so nothing here has to
 * special-case the first one. Throws on an unknown judge, via subdirFor.
 */
export function resultsDirFor(judgeId) {
  return path.join(RESULTS_ROOT, subdirFor(judgeId))
}

/** Absolute path to the shared human result set — see HUMAN_SUBDIR. */
export const HUMAN_RESULTS_DIR = path.join(RESULTS_ROOT, HUMAN_SUBDIR)
