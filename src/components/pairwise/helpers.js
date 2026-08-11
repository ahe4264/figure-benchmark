import { styles } from './styles.js'

export const DIMENSIONS = ['geometry', 'interactivity', 'faithfulness', 'labels', 'concept']

export const DIM_LABELS = {
  geometry: 'Geometry',
  interactivity: 'Interactivity',
  faithfulness: 'Faithfulness',
  labels: 'Labels',
  concept: 'Concept',
}

export const DIM_LABELS_SHORT = {
  geometry: 'Geo',
  interactivity: 'Inter',
  faithfulness: 'Faith',
  labels: 'Labels',
  concept: 'Concept',
}

export function winnerBadgeStyle(winner, setupA, setupB) {
  if (winner === 'tie') return { ...styles.pwWinnerBadge, ...styles.pwBadgeTie }
  if (winner === setupA) return { ...styles.pwWinnerBadge, ...styles.pwBadgeA }
  return { ...styles.pwWinnerBadge, ...styles.pwBadgeB }
}

// A setup id is a single experiments/ folder name, so there is no suffix to
// strip. Kept as a function so call sites match visionbook's.
export function shortSetup(id) {
  return id
}

export function sideLabel(winner, setupA, setupB) {
  if (winner === 'tie') return 'Tie'
  if (winner === setupA) return 'A'
  if (winner === setupB) return 'B'
  return winner
}

export { htmlUrl, imageUrl } from '../../urls.js'
