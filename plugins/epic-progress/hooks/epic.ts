import type { Child, EpicRef, StatusBucket } from '../types'

// The Jira projects whose keys count as "the ticket of this session", unless the `projects` option says otherwise.
export const DEFAULT_PROJECTS: readonly string[] = ['BDY']

// The Jira sites a project is looked for on, in this order, unless the `sites` option says otherwise.
export const DEFAULT_SITES: readonly string[] = ['quinventa.atlassian.net', 'faimstudio.atlassian.net']

// The fixed v2 connections on user scope (`~/.claude.json`), one per site, each with its own token.
// Where one is loaded it is the only way to that site; elsewhere the claude.ai connector is used.
export const SITE_SERVERS: Readonly<Record<string, string>> = {
  'quinventa.atlassian.net': 'buddy-atlassian',
  'faimstudio.atlassian.net': 'faim-atlassian',
}

const FIXED_SERVERS = new Set(Object.values(SITE_SERVERS))

const searchTool = (server: string) => `mcp__${server}__searchJiraIssuesUsingJql`

const keyPattern = (projects: readonly string[]) =>
  new RegExp(`(?<![A-Za-z0-9])(${projects.join('|')})-(\\d+)(?!\\d)`, 'i')

export const BUCKETS: readonly StatusBucket[] = ['progress', 'review', 'todo', 'done', 'dropped']

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  done: 'Done',
  review: 'In Review',
  progress: 'In Progress',
  todo: 'To Do',
  dropped: "Won't Do",
}

// Mid-tone colors that read on a light and a dark background alike.
export const BUCKET_COLOR: Record<StatusBucket, string> = {
  done: '#2E9E5B',
  review: '#8B6CD9',
  progress: '#D99A1E',
  todo: '#8A8F98',
  dropped: '#B4B8BF',
}

export type Progress = {
  total: number
  counts: Record<StatusBucket, number>
  percent: number
  remaining: number
  fieldTest: number
}

export type JiraNode = {
  key: string
  fields: {
    summary?: string
    labels?: string[]
    status?: { name?: string; statusCategory?: { key?: string } }
    issuetype?: { name?: string; hierarchyLevel?: number }
    parent?: JiraNode
  }
}

export type SearchPage = { nodes: JiraNode[]; nextPageToken?: string }

export type EpicCommand =
  | { kind: 'open' }
  | { kind: 'auto' }
  | { kind: 'off' }
  | { kind: 'key'; key: string }
  | { kind: 'unconfigured'; key: string; project: string }
  | { kind: 'search'; query: string }

export function findTicketKey(text: string, projects: readonly string[] = DEFAULT_PROJECTS): string | undefined {
  const match = keyPattern(projects).exec(text)

  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : undefined
}

export function parseProjects(value: string): string[] {
  const projects = value
    .split(/[\s,;]+/)
    .map(word => word.toUpperCase())
    .filter(word => /^[A-Z][A-Z0-9]{1,9}$/.test(word))

  return projects.length > 0 ? projects : [...DEFAULT_PROJECTS]
}

// A short name stands for <name>.atlassian.net; a URL keeps just its host.
export function parseSites(value: string): string[] {
  const sites = value
    .split(/[\s,;]+/)
    .map(word => word.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(word => /^[a-z0-9][a-z0-9.-]*$/.test(word))
    .map(word => (word.includes('.') ? word : `${word}.atlassian.net`))

  return sites.length > 0 ? sites : [...DEFAULT_SITES]
}

export function projectOf(key: string): string {
  return key.split('-')[0]!.toUpperCase()
}

export function browseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`
}

// The rule that lets a mod's call past auto mode, when that is what refused it.
export function permissionRule(message: string, server: string): string | undefined {
  if (!/refused|classifier|permission/i.test(message)) return undefined

  return searchTool(server.replace(/[^A-Za-z0-9_-]/g, '_'))
}

export function bucketOf(status: string, category: string): StatusBucket {
  if (/won'?t do|cancel|geannuleerd|vervallen|duplicate/i.test(status)) return 'dropped'
  if (category === 'done') return 'done'
  if (/review|beoordeel/i.test(status)) return 'review'
  if (category === 'indeterminate') return 'progress'

  return 'todo'
}

export function progressOf(children: readonly Child[]): Progress {
  const counts: Record<StatusBucket, number> = { done: 0, review: 0, progress: 0, todo: 0, dropped: 0 }
  for (const one of children) counts[one.bucket]++
  const total = children.length - counts.dropped
  const fieldTest = children.filter(one => one.isFieldTest && (one.bucket === 'done' || one.bucket === 'review')).length

  return {
    total,
    counts,
    percent: total === 0 ? 0 : Math.round((counts.done / total) * 100),
    remaining: total - counts.done,
    fieldTest,
  }
}

type ToolResult = { content: { type: string; text?: string }[]; isError: boolean }

export function resultText(result: ToolResult): string {
  const text = result.content.map(block => block.text ?? '').join('')
  if (result.isError) throw new Error(text || 'Jira gaf een fout terug')

  return text
}

// A result too large to hand over inline comes back as a notice naming the file it went to.
export function savedOutputPath(text: string): string | undefined {
  return /Output has been saved to ((?:\/|[A-Za-z]:\\)\S+?)\.?(?=\s|$)/.exec(text)?.[1]
}

// The claude.ai connector answers `{ issues: { nodes, pageInfo } }`, a v2 connection `{ data: { issues, nextPageToken, isLast } }`.
export function parsePage(text: string): SearchPage {
  let parsed: {
    issues?: { nodes?: JiraNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
    data?: { issues?: JiraNode[]; nextPageToken?: string; isLast?: boolean }
  }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`onverwacht antwoord van Jira: ${text.slice(0, 120)}`)
  }
  if (parsed.data) {
    const { issues, nextPageToken, isLast } = parsed.data

    return { nodes: issues ?? [], nextPageToken: !isLast && nextPageToken ? nextPageToken : undefined }
  }
  const pageInfo = parsed.issues?.pageInfo

  return {
    nodes: parsed.issues?.nodes ?? [],
    nextPageToken: pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : undefined,
  }
}

export function parseSearch(result: ToolResult): SearchPage {
  return parsePage(resultText(result))
}

export function toChild(node: JiraNode): Child {
  const status = node.fields.status?.name ?? '?'

  return {
    key: node.key,
    summary: node.fields.summary ?? '',
    status,
    bucket: bucketOf(status, node.fields.status?.statusCategory?.key ?? ''),
    isFieldTest: (node.fields.labels ?? []).includes('awaiting-field-test'),
  }
}

const isEpic = (node: JiraNode) =>
  node.fields.issuetype?.name === 'Epic' || node.fields.issuetype?.hierarchyLevel === 1

export function epicTarget(node: JiraNode): { epic: EpicRef } | { lookup: string } | undefined {
  if (isEpic(node)) return { epic: { key: node.key, summary: node.fields.summary ?? '' } }
  const parent = node.fields.parent
  if (!parent) return undefined
  if (isEpic(parent)) return { epic: { key: parent.key, summary: parent.fields.summary ?? '' } }

  return { lookup: parent.key }
}

export function filterEpics(epics: readonly EpicRef[], query: string): EpicRef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return epics.filter(epic => {
    const haystack = `${epic.key} ${epic.summary}`.toLowerCase()

    return words.every(word => haystack.includes(word))
  })
}

// The claude.ai connector behind searchJiraIssuesUsingJql; the fixed connections are not it.
export function serverFromToolNames(names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = /^mcp__(.+)__searchJiraIssuesUsingJql$/.exec(name)
    if (match && !FIXED_SERVERS.has(match[1]!)) return match[1]
  }

  return undefined
}

// The fixed connection of a site, when this session loaded it.
export function fixedServer(site: string, names: readonly string[]): string | undefined {
  const server = SITE_SERVERS[site]

  return server && names.includes(searchTool(server)) ? server : undefined
}

export function parseEpicCommand(args: string, projects: readonly string[] = DEFAULT_PROJECTS): EpicCommand {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  if (text.toLowerCase() === 'auto') return { kind: 'auto' }
  if (/^(uit|off|stop)$/i.test(text)) return { kind: 'off' }
  const key = findTicketKey(text, projects)
  if (key && text.toUpperCase() === key) return { kind: 'key', key }
  const other = /^([A-Z][A-Z0-9]{1,9})-\d+$/i.exec(text)
  if (other) return { kind: 'unconfigured', key: text.toUpperCase(), project: other[1]!.toUpperCase() }

  return { kind: 'search', query: text }
}

// The key settings.json files the plugin's options under: plain when loaded from a folder, `@marketplace` when installed.
export function configKey(root: string): string {
  const marketplace = /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]/.exec(root)?.[1]

  return marketplace ? `epic-progress@${marketplace}` : 'epic-progress'
}

export function statusLine(epic: EpicRef, progress: Progress): string {
  const filled = Math.round(progress.percent / 10)
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled)
  const tail =
    progress.total === 0
      ? 'nog geen tickets'
      : progress.remaining === 0
        ? 'klaar'
        : `nog ${progress.remaining} open ≈ ${progress.remaining} ${progress.remaining === 1 ? 'sessie' : 'sessies'}`

  return `${epic.key} ${bar} ${progress.percent}% · ${tail}`
}

export function sortChildren(children: readonly Child[]): Child[] {
  return [...children].sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket))
}

// Left to right on a bar: what is finished first, what is untouched last.
const BAR_ORDER: readonly StatusBucket[] = ['done', 'review', 'progress', 'todo']

export function segmentsOf(progress: Progress, cells: number): { bucket: StatusBucket; size: number }[] {
  if (progress.total === 0) return []
  let counted = 0
  let drawn = 0

  return BAR_ORDER.filter(bucket => progress.counts[bucket] > 0).map(bucket => {
    counted += progress.counts[bucket]
    const end = Math.round((counted / progress.total) * cells)
    const size = end - drawn
    drawn = end

    return { bucket, size }
  })
}

export function ringSvg(progress: Progress): string {
  const size = 72
  const r = 26
  const circumference = 2 * Math.PI * r
  const round = (n: number) => Math.round(n * 100) / 100
  let offset = 0
  const arcs = BAR_ORDER.filter(bucket => bucket !== 'todo' && progress.counts[bucket] > 0).map(bucket => {
    const length = (progress.counts[bucket] / progress.total) * circumference
    const arc = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${BUCKET_COLOR[bucket]}" stroke-width="10" stroke-dasharray="${round(length)} ${round(circumference)}" stroke-dashoffset="${round(-offset)}"><title>${BUCKET_LABEL[bucket]}: ${progress.counts[bucket]}</title></circle>`
    offset += length

    return arc
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${BUCKET_COLOR.todo}" stroke-opacity="0.3" stroke-width="10"/>` +
    `<g transform="rotate(-90 ${size / 2} ${size / 2})">${arcs.join('')}</g>` +
    `</svg>`
  )
}

export function barSvg(progress: Progress, width: number): string {
  const height = 14
  let x = 0
  const segments = segmentsOf(progress, width).map(({ bucket, size }) => {
    const rect = `<rect x="${x}" y="0" width="${size}" height="${height}" fill="${BUCKET_COLOR[bucket]}"><title>${BUCKET_LABEL[bucket]}: ${progress.counts[bucket]}</title></rect>`
    x += size

    return rect
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<clipPath id="r"><rect width="${width}" height="${height}" rx="7"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${width}" height="${height}" fill="${BUCKET_COLOR.todo}" opacity="0.25"/>${segments.join('')}</g>` +
    `</svg>`
  )
}
