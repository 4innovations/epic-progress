import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EpicRef, EpicView, Picker } from '../types'
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  DEFAULT_PROJECTS,
  DEFAULT_SITES,
  barSvg,
  browseUrl,
  configKey,
  epicTarget,
  filterEpics,
  findTicketKey,
  fixedServer,
  parseEpicCommand,
  parsePage,
  parseProjects,
  parseSites,
  permissionRule,
  progressOf,
  projectOf,
  resultText,
  ringSvg,
  savedOutputPath,
  segmentsOf,
  serverFromToolNames,
  sortChildren,
  statusLine,
  toChild,
} from './epic'
import type { JiraNode, SearchPage } from './epic'

type $ = EngineInterface

const PANE = 'epic-progress'
const TITLE = 'Epic-voortgang'
const FIELDS = ['summary', 'status', 'issuetype', 'parent', 'labels']
// Each refresh of a large Epic leaves a saved result file in the session folder; keep them few.
const REFRESH_MS = 15 * 60 * 1000
const MAX_PAGES = 5
const PICKER_ROWS = 20
// Tried when no claude.ai searchJiraIssuesUsingJql tool shows up in the tool list.
const FALLBACK_SERVERS = ['claude.ai Atlassian', 'atlassian']
// Jira writes that can move the Epic's numbers, and the ones that name "the" ticket (v1 and v2 names).
const WRITE_TOOL = /__(transitionJiraIssue|editJiraIssue|addCommentToJiraIssue|addOrEditJiraIssueComment|createJiraIssue)$/
const TICKET_TOOL = /__(transitionJiraIssue|editJiraIssue|addCommentToJiraIssue|addOrEditJiraIssueComment)$/

const ICON = { done: '✓', review: '◐', progress: '▶', todo: '○', dropped: '✕' } as const

const view = atom({ plugin: 'epic-progress', key: 'view' } as const, { children: [], isLoading: false } as EpicView)
const ticket = atom({ plugin: 'epic-progress', key: 'ticket' } as const, '')
const pinned = atom({ plugin: 'epic-progress', key: 'pinned' } as const, '')
const picker = atom({ plugin: 'epic-progress', key: 'picker' } as const, {
  isOpen: false,
  query: '',
  epics: [],
  isLoading: false,
} as Picker)
const server = atom({ plugin: 'epic-progress', key: 'server' } as const, '')
const autoOpened = atom({ plugin: 'epic-progress', key: 'autoOpened' } as const, false)
const branch = atom({ plugin: 'epic-progress', key: 'branch' } as const, '')
const isOff = atom({ plugin: 'epic-progress', key: 'isOff' } as const, false)
const siteOf = atom({ plugin: 'epic-progress', key: 'siteOf' } as const, {} as Record<string, string>)

// Set from the `projects` and `sites` options each time the module loads.
let projects: readonly string[] = DEFAULT_PROJECTS
let sites: readonly string[] = DEFAULT_SITES

class JiraError extends Error {
  constructor(
    message: string,
    readonly rule?: string,
  ) {
    super(message)
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)
const ruleOf = (error: unknown) => (error instanceof JiraError ? error.rule : undefined)

// Work that should not hold up the dispatch that noticed it (a prompt, a tool call).
function later($: $, work: () => Promise<unknown>) {
  $.clock.after(0, () => {
    void work().catch(() => {})
  })
}

async function toolNames($: $): Promise<string[]> {
  try {
    return (await $.tool.list()).map(tool => tool.name)
  } catch {
    return []
  }
}

// A site's fixed connection alone when this session loaded it (asked each time: it may connect
// late); otherwise the claude.ai connector, found once per session.
async function connectionsFor($: $, site: string): Promise<{ servers: string[]; isFixed: boolean }> {
  const names = await toolNames($)
  const fixed = fixedServer(site, names)
  if (fixed) return { servers: [fixed], isFixed: true }
  const known = await read($, server)
  if (known) return { servers: [known], isFixed: false }
  const found = serverFromToolNames(names)

  return { servers: found ? [found, ...FALLBACK_SERVERS] : FALLBACK_SERVERS, isFixed: false }
}

// A v2 connection's default compact view drops status categories, parents and labels, so ask
// for the full view; a connector that does not know `view` gets the call without it.
async function callFull($: $, name: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(name, 'searchJiraIssuesUsingJql', { ...args, view: 'full' })
  const isUnknownView = result.isError && result.content.some(block => /unrecognized key.*"view"/i.test(block.text ?? ''))

  return isUnknownView ? $.mcp.call(name, 'searchJiraIssuesUsingJql', args) : result
}

async function search(
  $: $,
  site: string,
  jql: string,
  fields: string[],
  { nextPageToken, maxResults = 100 }: { nextPageToken?: string; maxResults?: number } = {},
): Promise<SearchPage> {
  const { servers, isFixed } = await connectionsFor($, site)
  const args = { cloudId: site, jql, fields, maxResults, ...(nextPageToken && { nextPageToken }) }
  let firstError: unknown
  for (const name of servers) {
    try {
      const text = resultText(await callFull($, name, args))
      const saved = savedOutputPath(text)
      const page = parsePage(saved ? ((await $.fs.read(saved)) as string) : text)
      if (!isFixed) await update($, server, () => name)

      return page
    } catch (error) {
      const rule = permissionRule(messageOf(error), name)
      firstError ??= rule ? new JiraError(messageOf(error), rule) : error
    }
  }

  throw firstError ?? new Error('geen Atlassian-connector gevonden')
}

async function searchAll($: $, site: string, jql: string, fields: string[]): Promise<JiraNode[]> {
  const nodes: JiraNode[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await search($, site, jql, fields, { nextPageToken: token })
    nodes.push(...result.nodes)
    token = result.nextPageToken
    if (!token) break
  }

  return nodes
}

async function rememberSite($: $, project: string, site: string) {
  if (!(await read($, siteOf))[project]) await update($, siteOf, current => ({ ...current, [project]: site }))
}

// The Jira site a project lives on: the first of `sites` where it has tickets, found once per session.
// A site this session cannot reach is passed over; a call auto mode refused stops the search.
async function siteFor($: $, project: string): Promise<string> {
  const known = (await read($, siteOf))[project]
  if (known) return known
  let firstError: unknown
  for (const site of sites) {
    try {
      if ((await search($, site, `project = ${project}`, ['summary'], { maxResults: 1 })).nodes.length === 0) continue
      await rememberSite($, project, site)

      return site
    } catch (error) {
      if (ruleOf(error)) throw error
      firstError ??= error
    }
  }
  const why = firstError ? ` (${messageOf(firstError)})` : ''
  const names = await toolNames($)
  // Only the claude.ai connector depends on the Claude account; the fixed connections do not.
  const account = sites.every(site => fixedServer(site, names)) ? '' : ' met deze Atlassian-koppeling; ander Claude-account?'

  throw new Error(`${project} niet gevonden op ${sites.join(', ')}${account}${why}`)
}

// False when no site this account reaches has the project: such a ticket is passed over, not
// made the session ticket. A refusal by auto mode counts as reachable, so its rule gets shown.
async function isReachable($: $, project: string): Promise<boolean> {
  try {
    await siteFor($, project)

    return true
  } catch (error) {
    return ruleOf(error) !== undefined
  }
}

async function epicForKey($: $, key: string): Promise<EpicRef | undefined> {
  const site = await siteFor($, projectOf(key))
  const [node] = (await search($, site, `key = ${key}`, FIELDS)).nodes
  if (!node) throw new Error(`${key} niet gevonden in Jira`)
  const target = epicTarget(node)
  if (target && 'lookup' in target) {
    const [parent] = (await search($, site, `key = ${target.lookup}`, FIELDS)).nodes
    const above = parent && epicTarget(parent)
    if (!above || !('epic' in above)) return undefined
    await rememberSite($, projectOf(above.epic.key), site)

    return above.epic
  }
  if (target) await rememberSite($, projectOf(target.epic.key), site)

  return target?.epic
}

async function showEpic($: $, epic: EpicRef) {
  await update($, view, current => ({
    ...current,
    epic,
    children: current.epic?.key === epic.key ? current.children : [],
    updatedAt: current.epic?.key === epic.key ? current.updatedAt : undefined,
    isLoading: true,
    error: undefined,
    hint: undefined,
    note: undefined,
  }))
  try {
    const site = await siteFor($, projectOf(epic.key))
    const children = (await searchAll($, site, `parent = ${epic.key} ORDER BY created ASC`, FIELDS)).map(toChild)
    const updatedAt = await $.clock.now()
    await update($, view, () => ({ epic, children, updatedAt, isLoading: false }))
    if (!(await read($, isOff))) $.ui.status(statusLine(epic, progressOf(children)))
  } catch (error) {
    await update($, view, current => ({ ...current, isLoading: false, error: messageOf(error), hint: ruleOf(error) }))
  }
}

async function showKey($: $, key: string) {
  await update($, view, current => ({ ...current, isLoading: true, error: undefined, hint: undefined, note: undefined }))
  try {
    const epic = await epicForKey($, key)
    if (!epic) {
      await update($, view, () => ({
        children: [],
        isLoading: false,
        note: `${key} hoort niet bij een Epic. Kies er een om in dit paneel te tonen; in Jira verandert er niets.`,
      }))
      $.ui.status(undefined)

      return undefined
    }
    await showEpic($, epic)

    return epic
  } catch (error) {
    await update($, view, current => ({ ...current, isLoading: false, error: messageOf(error), hint: ruleOf(error) }))

    return undefined
  }
}

async function autoOpen($: $) {
  if ((await read($, autoOpened)) || (await read($, isOff))) return
  if (!(await read($, view)).epic) return
  await update($, autoOpened, () => true)
  await $.ui.open({ id: PANE, title: TITLE })
}

// A ticket came by; true when that loaded an Epic. One session is one ticket: the first one
// that comes by stays, and only the branch name overrides it. `/epic <ticket>` switches on purpose.
async function onTicket($: $, key: string, isBranch = false): Promise<boolean> {
  const current = await read($, ticket)
  if (key === current || (current !== '' && !isBranch)) return false
  if (!(await read($, isOff)) && !(await isReachable($, projectOf(key)))) return false
  await update($, ticket, () => key)
  if ((await read($, pinned)) || (await read($, isOff))) return false
  await showKey($, key)
  await autoOpen($)

  return true
}

async function refresh($: $) {
  if (await read($, isOff)) return
  const { epic } = await read($, view)
  if (epic) await showEpic($, epic)
}

async function checkBranch($: $) {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
    const name = exitCode === 0 ? stdout.trim() : ''
    if (name === (await read($, branch))) return
    await update($, branch, () => name)
    const key = findTicketKey(name, projects)
    if (key) await onTicket($, key, true)
  } catch {}
}

// The configured projects grouped per Jira site. A project no reachable site has is left out,
// unless that leaves nothing: then its error is the picker's.
async function projectsBySite($: $): Promise<{ groups: Map<string, string[]>; skipped: string[] }> {
  const groups = new Map<string, string[]>()
  const skipped: string[] = []
  let firstError: unknown
  for (const project of projects) {
    try {
      const site = await siteFor($, project)
      groups.set(site, [...(groups.get(site) ?? []), project])
    } catch (error) {
      if (ruleOf(error)) throw error
      firstError ??= error
      skipped.push(project)
    }
  }
  if (groups.size === 0 && firstError) throw firstError

  return { groups, skipped }
}

const skippedNote = (skipped: readonly string[] | undefined) =>
  skipped?.length ? ` Niet doorzocht: ${skipped.join(', ')} (niet bereikbaar met dit Claude-account).` : ''

async function openPicker($: $, query: string): Promise<EpicRef[]> {
  await update($, picker, () => ({ isOpen: true, query, epics: [], isLoading: true }))
  try {
    const nodes: JiraNode[] = []
    const { groups, skipped } = await projectsBySite($)
    for (const [site, group] of groups) {
      nodes.push(
        ...(await searchAll(
          $,
          site,
          `project in (${group.join(', ')}) AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`,
          ['summary', 'status', 'issuetype'],
        )),
      )
    }
    const epics = nodes
      .map(toChild)
      .filter(one => one.bucket !== 'done' && one.bucket !== 'dropped')
      .map(({ key, summary }) => ({ key, summary }))
    await update($, picker, current => ({ ...current, epics, skipped, isLoading: false }))

    return epics
  } catch (error) {
    await update($, picker, current => ({ ...current, isLoading: false, error: messageOf(error), hint: ruleOf(error) }))

    return []
  }
}

async function pick($: $, epic: EpicRef) {
  await update($, picker, current => ({ ...current, isOpen: false }))
  await update($, pinned, () => epic.key)
  await showEpic($, epic)
}

async function unpin($: $) {
  await update($, pinned, () => '')
  const key = await read($, ticket)
  if (key) await showKey($, key)
}

function updatedText(ms: number | undefined) {
  if (ms === undefined) return ''
  try {
    return ` · bijgewerkt ${new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  projects = parseProjects(String(options.projects ?? ''))
  sites = parseSites(String(options.sites ?? ''))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'epic',
      description:
        'Voortgang van de Epic van dit ticket; /epic BDY-123 of /epic <titel> zet er een vast, /epic auto volgt weer het ticket, /epic uit zet hem uit',
      argumentHint: '[ticket | titel | auto | uit]',
    })
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => {}))
    later($, async () => {
      const { epic, children, updatedAt } = await read($, view)
      if (epic && updatedAt !== undefined && !(await read($, isOff))) $.ui.status(statusLine(epic, progressOf(children)))
      await checkBranch($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    later($, () => checkBranch($))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const key = findTicketKey(e.text, projects)
    if (key) later($, () => onTicket($, key))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITE_TOOL.test(e.tool)) {
      const named = (e as { issueIdOrKey?: unknown }).issueIdOrKey
      const key = typeof named === 'string' && TICKET_TOOL.test(e.tool) ? findTicketKey(named, projects) : undefined
      later($, async () => {
        if (key && (await onTicket($, key))) return
        await refresh($)
      })
    }

    return result
  })

  on('command.run', { command: 'epic' }, async ($, e) => {
    const command = parseEpicCommand(e.args, projects)
    if (command.kind === 'off') {
      await update($, isOff, () => true)
      await $.ui.close({ id: PANE })
      $.ui.status(undefined)

      return { text: 'Epic-voortgang staat uit voor deze sessie; typ /epic om hem weer aan te zetten.' }
    }
    if (command.kind === 'unconfigured') {
      const wanted = [...projects, command.project].join(',')

      return {
        text:
          `${command.project} staat niet in je projecten (nu: ${projects.join(',')}). ` +
          `Voeg het toe in ~/.claude/settings.json: "pluginConfigs": { "${configKey($.plugin.root)}": { "options": { "projects": "${wanted}" } } }`,
      }
    }
    await update($, isOff, () => false)
    await update($, autoOpened, () => true)
    await $.ui.open({ id: PANE, title: TITLE })

    if (command.kind === 'auto') {
      await unpin($)

      return { text: 'Epic-voortgang volgt weer het ticket van deze sessie.' }
    }
    if (command.kind === 'key') {
      const epic = await showKey($, command.key)
      if (epic) {
        await update($, pinned, () => epic.key)
        if (epic.key !== command.key) await update($, ticket, () => command.key)
      }

      if (epic) return { text: `Epic ${epic.key} vastgezet.` }
      const { error } = await read($, view)

      return { text: error ? `Jira-fout: ${error}` : `Geen Epic gevonden voor ${command.key}.` }
    }
    if (command.kind === 'search') {
      const matches = filterEpics(await openPicker($, command.query), command.query)
      if (matches.length === 1) {
        await pick($, matches[0]!)

        return { text: `Epic ${matches[0]!.key} vastgezet.` }
      }
      const { error, skipped } = await read($, picker)
      if (error) return { text: `Jira-fout: ${error}` }
      if (matches.length === 0) return { text: `Geen open Epic voor "${command.query}".${skippedNote(skipped)}` }

      return { text: `${matches.length} Epics gevonden voor "${command.query}"; kies er een in het paneel.` }
    }
    const { epic } = await read($, view)
    const current = await read($, ticket)
    if (epic) await refresh($)
    else if (current) await showKey($, current)
    else await openPicker($, '')

    return { text: 'Epic-voortgang geopend.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link, Code } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
    const columns = Math.max(20, e.props.bodyColumns)
    const choose = await read($, picker)
    const shown = await read($, view)
    const current = await read($, ticket)
    const isPinned = (await read($, pinned)) !== ''
    const siteOfProject = await read($, siteOf)
    const ruleBlock = (rule: string | undefined) =>
      rule && (
        <Box key="rule" flexDirection="column">
          <Text dimColor>Auto mode laat de mod niet bij Jira. Zet deze regel in ~/.claude/settings.json onder permissions.allow:</Text>
          <Code source={rule} />
          <Box flexDirection="row">
            <Button key="copy-rule" onPress={press => void $.ui.copy({ text: rule, surface: press.surface })}>
              Kopieer regel
            </Button>
          </Box>
        </Box>
      )

    if (choose.isOpen) {
      const matches = filterEpics(choose.epics, choose.query)

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Kies een Epic</Text>
          {Input && (
            <Input
              key="filter"
              placeholder="Filter op titel of key…"
              value={choose.query}
              submitLabel="kies"
              autoFocus
              onInput={value => void update($, picker, p => ({ ...p, query: value }))}
              onSubmit={async value => {
                const only = filterEpics((await read($, picker)).epics, value)
                if (only.length === 1) await pick($, only[0]!)
                else await update($, picker, p => ({ ...p, query: value }))
              }}
            />
          )}
          {choose.isLoading && <Text dimColor>Epics laden…</Text>}
          {choose.error && <Text color="#D64545">{`Jira: ${choose.error}`}</Text>}
          {ruleBlock(choose.hint)}
          <Box flexDirection="column">
            {matches.slice(0, PICKER_ROWS).map(epic => (
              <Button key={`pick:${epic.key}`} plain onPress={() => pick($, epic)}>
                {`${epic.key}  ${epic.summary}`}
              </Button>
            ))}
          </Box>
          {matches.length > PICKER_ROWS && <Text dimColor>{`+${matches.length - PICKER_ROWS} meer; verfijn je filter`}</Text>}
          {!choose.isLoading && !choose.error && matches.length === 0 && (
            <Text dimColor>{`Geen open Epic met "${choose.query}".${skippedNote(choose.skipped)}`}</Text>
          )}
          <Box flexDirection="row">
            <Button key="cancel" onPress={() => update($, picker, p => ({ ...p, isOpen: false }))}>
              Annuleren
            </Button>
          </Box>
        </Box>
      )
    }

    const { epic } = shown
    if (!epic) {
      return (
        <Box flexDirection="column" gap={1}>
          {shown.isLoading && <Text dimColor>Laden…</Text>}
          {shown.error && <Text color="#D64545">{`Jira: ${shown.error}`}</Text>}
          {ruleBlock(shown.hint)}
          <Text>{shown.note ?? `Nog geen Epic: werk aan een ${projects.join('/')}-ticket, of kies er een.`}</Text>
          <Box flexDirection="row">
            <Button key="choose" variant="primary" onPress={() => openPicker($, '')}>
              Kies een Epic
            </Button>
          </Box>
        </Box>
      )
    }

    // Only a load that succeeded has numbers worth drawing; a failed one would read as "no tickets".
    const hasData = shown.updatedAt !== undefined
    const progress = progressOf(shown.children)
    const sessions =
      progress.total === 0
        ? 'Nog geen tickets onder deze Epic.'
        : progress.remaining === 0
          ? 'Alle tickets zijn klaar.'
          : `Nog ${progress.remaining} open ≈ ${progress.remaining} ${progress.remaining === 1 ? 'sessie' : 'sessies'}`
    const legend = (['done', 'review', 'progress', 'todo'] as const).filter(bucket => progress.counts[bucket] > 0)
    const cells = Math.min(columns - 2, 48)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Link href={browseUrl(siteOfProject[projectOf(epic.key)] ?? sites[0]!, epic.key)} label={epic.key} />
          <Text bold wrap="wrap">
            {epic.summary}
          </Text>
        </Box>
        {hasData && (
          <Box flexDirection="row" gap={2} alignItems="center">
            {Svg && <Svg source={ringSvg(progress)} alt={`${progress.percent}% klaar`} width={72} height={72} />}
            <Box flexDirection="column">
              <Text bold color={BUCKET_COLOR.done}>{`${progress.percent}% klaar`}</Text>
              <Text dimColor>{`${progress.counts.done} van ${progress.total} tickets done`}</Text>
              <Text>{sessions}</Text>
            </Box>
          </Box>
        )}
        {hasData &&
          (Svg ? (
            <Svg source={barSvg(progress, 480)} alt={legend.map(b => `${BUCKET_LABEL[b]} ${progress.counts[b]}`).join(', ')} />
          ) : (
            <Box flexDirection="row">
              {segmentsOf(progress, cells).map(({ bucket, size }) => (
                <Text color={BUCKET_COLOR[bucket]} dimColor={bucket === 'todo'}>
                  {(bucket === 'todo' ? '░' : '█').repeat(size)}
                </Text>
              ))}
            </Box>
          ))}
        {hasData && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {legend.map(bucket => (
              <Text color={BUCKET_COLOR[bucket]}>{`● ${BUCKET_LABEL[bucket]} ${progress.counts[bucket]}`}</Text>
            ))}
          </Box>
        )}
        {progress.fieldTest > 0 && (
          <Text dimColor>{`🧪 ${progress.fieldTest} ${progress.fieldTest === 1 ? 'wacht' : 'wachten'} op veldtest`}</Text>
        )}
        {shown.isLoading && <Text dimColor>{hasData ? 'Vernieuwen…' : 'Laden…'}</Text>}
        {shown.error && <Text color="#D64545">{`Jira: ${shown.error}`}</Text>}
        {ruleBlock(shown.hint)}
        <Box flexDirection="column">
          {sortChildren(shown.children).map(child => (
            <Box key={`row:${child.key}`} flexDirection="row" gap={1}>
              <Text color={BUCKET_COLOR[child.bucket]}>{ICON[child.bucket]}</Text>
              <Text
                bold={child.key === current}
                dimColor={child.bucket === 'done' || child.bucket === 'dropped'}
                strikethrough={child.bucket === 'dropped'}
                wrap="truncate-end"
              >
                {`${child.key} ${child.summary}${child.key === current ? '  ← deze sessie' : ''}`}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" onPress={() => refresh($)}>
            Vernieuwen
          </Button>
          <Button key="choose" onPress={() => openPicker($, '')}>
            Wissel Epic
          </Button>
          {isPinned && (
            <Button key="auto" onPress={() => unpin($)}>
              Automatisch volgen
            </Button>
          )}
        </Box>
        <Text dimColor>{`${isPinned ? 'Vastgezet' : 'Volgt het ticket van deze sessie'}${updatedText(shown.updatedAt)}`}</Text>
      </Box>
    )
  })
}
