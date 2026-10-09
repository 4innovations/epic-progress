import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_SITES,
  barSvg,
  browseUrl,
  bucketOf,
  configKey,
  epicTarget,
  filterEpics,
  findTicketKey,
  fixedServer,
  parseEpicCommand,
  parsePage,
  parseProjects,
  parseSearch,
  parseSites,
  permissionRule,
  progressOf,
  projectOf,
  savedOutputPath,
  ringSvg,
  segmentsOf,
  serverFromToolNames,
  sortChildren,
  statusLine,
  toChild,
} from '../hooks/epic'
import type { Child } from '../types'

const child = (key: string, bucket: Child['bucket'], isFieldTest = false): Child => ({
  key,
  summary: `Ticket ${key}`,
  status: bucket,
  bucket,
  isFieldTest,
})

// Trimmed from a real searchJiraIssuesUsingJql answer (BDY, 2026-10-04).
const NODE = {
  key: 'BDY-1407',
  fields: {
    summary: 'Android backup — keep the tablet identity out of cloud backup',
    labels: ['android', 'awaiting-field-test'],
    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Task', subtask: false, hierarchyLevel: 0 },
    parent: {
      key: 'BDY-750',
      fields: {
        summary: 'Security Audit 2026-07 — Remediation',
        status: { name: 'To Do' },
        issuetype: { name: 'Epic', hierarchyLevel: 1 },
      },
    },
  },
}

const answer = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  content: [{ type: 'text', text: JSON.stringify({ issues: { nodes, pageInfo: { hasNextPage, endCursor } } }) }],
  isError: false,
})

test('findTicketKey picks the BDY key out of a prompt', async () => {
  expect(findTicketKey('Pak BDY-1407 op, daarna BDY-12')).toBe('BDY-1407')
})

test('findTicketKey reads a lowercase key out of a branch name', async () => {
  expect(findTicketKey('feature/bdy-1407-android-backup')).toBe('BDY-1407')
})

test('findTicketKey ignores look-alikes such as UTF-8 and ABDY-12', async () => {
  expect(findTicketKey('UTF-8, ISO-8601 en ABDY-12')).toBe(undefined)
})

test('findTicketKey recognises the projects it is given, and only those', async () => {
  expect(findTicketKey('Werk aan CUR-12', ['BDY', 'CUR'])).toBe('CUR-12')
  expect(findTicketKey('Werk aan CUR-12')).toBe(undefined)
})

test('parseProjects reads a comma list, uppercases it and drops what is no project key', async () => {
  expect(parseProjects('BDY, cur')).toEqual(['BDY', 'CUR'])
  expect(parseProjects('BDY;X-1; cur')).toEqual(['BDY', 'CUR'])
  expect(parseProjects('  ')).toEqual(['BDY'])
})

test('permissionRule names the allow rule when auto mode refused the call', async () => {
  const refused = '$.mcp.call(142d42cb-b71e, searchJiraIssuesUsingJql) refused: The server-side auto mode classifier gave no verdict'

  expect(permissionRule(refused, '142d42cb-b71e')).toBe('mcp__142d42cb-b71e__searchJiraIssuesUsingJql')
  expect(permissionRule(refused, 'claude.ai Atlassian')).toBe('mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql')
  expect(permissionRule('JQL invalid', '142d42cb-b71e')).toBe(undefined)
})

test('bucketOf sorts the BDY statuses into buckets', async () => {
  expect(bucketOf('Done', 'done')).toBe('done')
  expect(bucketOf('In Review', 'indeterminate')).toBe('review')
  expect(bucketOf('In Progress', 'indeterminate')).toBe('progress')
  expect(bucketOf('To Do', 'new')).toBe('todo')
  expect(bucketOf("Won't Do", 'new')).toBe('dropped')
})

test('progressOf leaves dropped tickets out of the total', async () => {
  const progress = progressOf([
    child('BDY-1', 'done'),
    child('BDY-2', 'done', true),
    child('BDY-3', 'review', true),
    child('BDY-4', 'progress'),
    child('BDY-5', 'todo'),
    child('BDY-6', 'dropped'),
  ])

  expect(progress.total).toBe(5)
  expect(progress.counts).toEqual({ done: 2, review: 1, progress: 1, todo: 1, dropped: 1 })
  expect(progress.percent).toBe(40)
  expect(progress.remaining).toBe(3)
  expect(progress.fieldTest).toBe(2)
})

test('progressOf of an empty epic is zero percent', async () => {
  expect(progressOf([]).percent).toBe(0)
})

test('parseSearch reads the issues and the next page token', async () => {
  const page = parseSearch(answer([NODE], true, 'abc'))

  expect(page.nodes[0]?.key).toBe('BDY-1407')
  expect(page.nextPageToken).toBe('abc')
})

test('parseSearch throws the server text when the call failed', async () => {
  const failed = { content: [{ type: 'text', text: 'JQL invalid' }], isError: true }

  expect(() => parseSearch(failed)).toThrow('JQL invalid')
})

test('savedOutputPath finds the file a too-large result was saved to', async () => {
  const text =
    'Error: result (75,929 characters) exceeds maximum allowed tokens. Output has been saved to /Users/r/.claude/projects/x/tool-results/mcp-search-1791.txt.\nFormat: JSON with schema: {issues: {...}}'

  expect(savedOutputPath(text)).toBe('/Users/r/.claude/projects/x/tool-results/mcp-search-1791.txt')
  expect(savedOutputPath('{"issues":{}}')).toBe(undefined)
})

test('savedOutputPath finds a Windows path too', async () => {
  const text =
    'Error: result (75,929 characters) exceeds maximum allowed tokens. Output has been saved to C:\\Users\\o\\.claude\\projects\\x\\tool-results\\mcp-search-1791.txt.\nFormat: JSON'

  expect(savedOutputPath(text)).toBe('C:\\Users\\o\\.claude\\projects\\x\\tool-results\\mcp-search-1791.txt')
})

test('parsePage reads the answer of a v2 connection (faim-atlassian, buddy-atlassian)', async () => {
  const issue = { key: 'BDY-1', fields: { summary: 'A' } }

  expect(parsePage(JSON.stringify({ data: { issues: [issue], nextPageToken: 'next', isLast: false } }))).toEqual({
    nodes: [issue],
    nextPageToken: 'next',
  })
  expect(parsePage(JSON.stringify({ data: { issues: [issue], nextPageToken: 'stale', isLast: true } }))).toEqual({
    nodes: [issue],
    nextPageToken: undefined,
  })
})

test('parsePage names the unexpected answer instead of a bare JSON error', async () => {
  expect(() => parsePage('Error: something else went wrong')).toThrow('onverwacht antwoord van Jira: Error: something else')
})

test('toChild maps a node, field-test label included', async () => {
  expect(toChild(NODE)).toEqual({
    key: 'BDY-1407',
    summary: 'Android backup — keep the tablet identity out of cloud backup',
    status: 'In Review',
    bucket: 'review',
    isFieldTest: true,
  })
})

test('epicTarget takes the parent when the parent is an Epic', async () => {
  expect(epicTarget(NODE)).toEqual({ epic: { key: 'BDY-750', summary: 'Security Audit 2026-07 — Remediation' } })
})

test('epicTarget takes the issue itself when it is an Epic', async () => {
  const epic = { key: 'BDY-750', fields: { summary: 'Security Audit', issuetype: { name: 'Epic', hierarchyLevel: 1 } } }

  expect(epicTarget(epic)).toEqual({ epic: { key: 'BDY-750', summary: 'Security Audit' } })
})

test('epicTarget asks for a lookup when the parent is a task (subtask)', async () => {
  const sub = {
    key: 'BDY-1500',
    fields: {
      summary: 'Sub',
      issuetype: { name: 'Subtask', subtask: true, hierarchyLevel: -1 },
      parent: { key: 'BDY-1407', fields: { summary: 'Task', issuetype: { name: 'Task', hierarchyLevel: 0 } } },
    },
  }

  expect(epicTarget(sub)).toEqual({ lookup: 'BDY-1407' })
})

test('epicTarget is undefined for a ticket outside any Epic', async () => {
  const loose = { key: 'BDY-9', fields: { summary: 'Los', issuetype: { name: 'Task', hierarchyLevel: 0 } } }

  expect(epicTarget(loose)).toBe(undefined)
})

test('filterEpics matches every word, on title or key, ignoring case', async () => {
  const epics = [
    { key: 'BDY-750', summary: 'Security Audit 2026-07 — Remediation' },
    { key: 'BDY-365', summary: 'API Security & Hardening' },
    { key: 'BDY-494', summary: 'Tablet Onboarding — Frictionless WiFi Setup' },
  ]

  expect(filterEpics(epics, 'security audit').map(e => e.key)).toEqual(['BDY-750'])
  expect(filterEpics(epics, 'bdy-494').map(e => e.key)).toEqual(['BDY-494'])
  expect(filterEpics(epics, '  ')).toHaveLength(3)
})

test('serverFromToolNames finds the server behind searchJiraIssuesUsingJql', async () => {
  const names = ['Read', 'mcp__142d42cb-b71e__getJiraIssue', 'mcp__142d42cb-b71e__searchJiraIssuesUsingJql']

  expect(serverFromToolNames(names)).toBe('142d42cb-b71e')
  expect(serverFromToolNames(['Read'])).toBe(undefined)
})

test('serverFromToolNames passes over the fixed connections', async () => {
  const names = ['mcp__buddy-atlassian__searchJiraIssuesUsingJql', 'mcp__142d42cb-b71e__searchJiraIssuesUsingJql']

  expect(serverFromToolNames(names)).toBe('142d42cb-b71e')
  expect(serverFromToolNames(['mcp__faim-atlassian__searchJiraIssuesUsingJql'])).toBe(undefined)
})

test('fixedServer names the connection of a site when it is loaded', async () => {
  const names = ['Read', 'mcp__buddy-atlassian__searchJiraIssuesUsingJql', 'mcp__142d42cb-b71e__searchJiraIssuesUsingJql']

  expect(fixedServer('quinventa.atlassian.net', names)).toBe('buddy-atlassian')
  expect(fixedServer('faimstudio.atlassian.net', names)).toBe(undefined)
  expect(fixedServer('faimstudio.atlassian.net', ['mcp__faim-atlassian__searchJiraIssuesUsingJql'])).toBe('faim-atlassian')
  expect(fixedServer('example.atlassian.net', names)).toBe(undefined)
})

test('parseEpicCommand tells open, auto, a key and a title search apart', async () => {
  expect(parseEpicCommand('')).toEqual({ kind: 'open' })
  expect(parseEpicCommand(' auto ')).toEqual({ kind: 'auto' })
  expect(parseEpicCommand('bdy-365')).toEqual({ kind: 'key', key: 'BDY-365' })
  expect(parseEpicCommand('tablet onboarding')).toEqual({ kind: 'search', query: 'tablet onboarding' })
  expect(parseEpicCommand('cur-12', ['BDY', 'CUR'])).toEqual({ kind: 'key', key: 'CUR-12' })
})

test('parseEpicCommand turns the mod off on uit, off or stop', async () => {
  expect(parseEpicCommand('uit')).toEqual({ kind: 'off' })
  expect(parseEpicCommand(' Off ')).toEqual({ kind: 'off' })
  expect(parseEpicCommand('stop')).toEqual({ kind: 'off' })
})

test('parseEpicCommand flags a ticket key of a project that is not configured', async () => {
  expect(parseEpicCommand('cur-12')).toEqual({ kind: 'unconfigured', key: 'CUR-12', project: 'CUR' })
})

test('configKey names the settings key the plugin is loaded under', async () => {
  expect(configKey('/Users/d/.claude/plugins/cache/quinventa-claude-plugins/epic-progress/0.2.0')).toBe(
    'epic-progress@quinventa-claude-plugins',
  )
  expect(configKey('/Users/r/Projects/claude-mods/epic-progress')).toBe('epic-progress')
})

test('configKey reads a Windows plugin path too', async () => {
  expect(configKey('C:\\Users\\o\\.claude\\plugins\\cache\\epic-progress\\epic-progress\\0.2.0')).toBe(
    'epic-progress@epic-progress',
  )
})

test('statusLine shows key, bar, percent and the sessions to go', async () => {
  const epic = { key: 'BDY-750', summary: 'Security Audit' }
  const progress = progressOf([child('BDY-1', 'done'), child('BDY-2', 'done'), child('BDY-3', 'todo'), child('BDY-4', 'todo'), child('BDY-5', 'review')])

  expect(statusLine(epic, progress)).toBe('BDY-750 ▰▰▰▰▱▱▱▱▱▱ 40% · nog 3 open ≈ 3 sessies')
})

test('statusLine says one session in the singular and done at 100%', async () => {
  const epic = { key: 'BDY-750', summary: 'Security Audit' }

  expect(statusLine(epic, progressOf([child('BDY-1', 'done'), child('BDY-2', 'todo')]))).toBe(
    'BDY-750 ▰▰▰▰▰▱▱▱▱▱ 50% · nog 1 open ≈ 1 sessie',
  )
  expect(statusLine(epic, progressOf([child('BDY-1', 'done')]))).toBe('BDY-750 ▰▰▰▰▰▰▰▰▰▰ 100% · klaar')
})

test('statusLine of an Epic without tickets does not claim it is done', async () => {
  expect(statusLine({ key: 'BDY-494', summary: 'Tablet' }, progressOf([]))).toBe('BDY-494 ▱▱▱▱▱▱▱▱▱▱ 0% · nog geen tickets')
})

test('sortChildren puts work in flight first and dropped last', async () => {
  const sorted = sortChildren([
    child('BDY-1', 'done'),
    child('BDY-2', 'dropped'),
    child('BDY-3', 'todo'),
    child('BDY-4', 'review'),
    child('BDY-5', 'progress'),
    child('BDY-6', 'todo'),
  ])

  expect(sorted.map(c => c.key)).toEqual(['BDY-5', 'BDY-4', 'BDY-3', 'BDY-6', 'BDY-1', 'BDY-2'])
})

test('segmentsOf splits the cells per bucket and always fills them all', async () => {
  const progress = progressOf([child('BDY-1', 'done'), child('BDY-2', 'review'), child('BDY-3', 'todo')])

  expect(segmentsOf(progress, 10)).toEqual([
    { bucket: 'done', size: 3 },
    { bucket: 'review', size: 4 },
    { bucket: 'todo', size: 3 },
  ])
})

test('ringSvg draws the done share as an arc of the circle', async () => {
  const svg = ringSvg(progressOf([child('BDY-1', 'done'), child('BDY-2', 'todo'), child('BDY-3', 'todo'), child('BDY-4', 'todo')]))

  expect(svg).toContain('<title>Done: 1</title>')
  expect(svg).toMatch(/stroke-dasharray="40\.84 163\.36"/)
})

test('barSvg draws one titled segment per bucket in proportion', async () => {
  const svg = barSvg(progressOf([child('BDY-1', 'done'), child('BDY-2', 'done'), child('BDY-3', 'todo'), child('BDY-4', 'review')]), 400)

  expect(svg).toContain('<title>Done: 2</title>')
  expect(svg).toContain('<title>In Review: 1</title>')
  expect(svg).toContain('<title>To Do: 1</title>')
  expect(svg).not.toContain('In Progress')
  expect(svg).toContain('width="200"')
})

test('parseSites turns short names and URLs into Jira hosts', async () => {
  expect(parseSites('quinventa, faimstudio')).toEqual(['quinventa.atlassian.net', 'faimstudio.atlassian.net'])
  expect(parseSites('https://Faimstudio.atlassian.net/')).toEqual(['faimstudio.atlassian.net'])
})

test('parseSites falls back to the Quinventa and FAIM sites', async () => {
  expect(parseSites('')).toEqual(['quinventa.atlassian.net', 'faimstudio.atlassian.net'])
  expect(DEFAULT_SITES).toEqual(['quinventa.atlassian.net', 'faimstudio.atlassian.net'])
})

test('projectOf takes the project from a ticket key', async () => {
  expect(projectOf('FAIM-612')).toBe('FAIM')
  expect(projectOf('BDY-7')).toBe('BDY')
})

test('browseUrl links a key on its Jira site', async () => {
  expect(browseUrl('faimstudio.atlassian.net', 'FAIM-612')).toBe('https://faimstudio.atlassian.net/browse/FAIM-612')
})

test('bucketOf counts a cancelled ticket in Dutch as dropped', async () => {
  expect(bucketOf('Geannuleerd', 'done')).toBe('dropped')
})
