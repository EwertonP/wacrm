"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'bg-primary-soft text-primary' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'bg-blue-500/10 text-blue-500 dark:text-blue-400' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'bg-amber-500/10 text-amber-500 dark:text-amber-400' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'bg-primary-soft text-primary' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm transition-all hover:border-border hover:bg-muted/30 hover:shadow-md"
          >
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground truncate">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
