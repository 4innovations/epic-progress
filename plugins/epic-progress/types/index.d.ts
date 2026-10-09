export type StatusBucket = 'done' | 'review' | 'progress' | 'todo' | 'dropped'

export type EpicRef = { key: string; summary: string }

export type Child = {
  key: string
  summary: string
  status: string
  bucket: StatusBucket
  isFieldTest: boolean
}

export type EpicView = {
  epic?: EpicRef
  children: Child[]
  updatedAt?: number
  isLoading: boolean
  error?: string
  // The allow rule to add when auto mode refused the Jira call.
  hint?: string
  note?: string
}

export type Picker = {
  isOpen: boolean
  query: string
  epics: EpicRef[]
  isLoading: boolean
  error?: string
  hint?: string
  // Configured projects no site this account reaches has; the picker could not search them.
  skipped?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'epic-progress': {
      view: EpicView
      ticket: string
      pinned: string
      picker: Picker
      // The claude.ai Atlassian connector found this session; the fixed connections are not kept here.
      server: string
      autoOpened: boolean
      branch: string
      // `/epic uit`: no pane, status line or following until the next /epic.
      isOff: boolean
      // The Jira site (host) each project was found on this session.
      siteOf: Record<string, string>
    }
  }
}
