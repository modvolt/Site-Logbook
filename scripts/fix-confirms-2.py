"""
Fix remaining confirm() replacements and missing hooks/JSX.
Run from workspace root: python3 scripts/fix-confirms-2.py
"""

def rb(raw, old, new, label=""):
    if old in raw:
        return raw.replace(old, new, 1)
    print(f"  NOT FOUND [{label}]")
    return raw

def proc(filepath, fn):
    with open(filepath, 'rb') as f:
        raw = f.read()
    raw2 = fn(raw)
    with open(filepath, 'wb') as f:
        f.write(raw2)
    if raw2 != raw:
        print(f"OK {filepath}")
    else:
        print(f"NO CHANGE {filepath}")

IMPORT_LINES = (
    b'\nimport { ConfirmDialog } from "@/components/confirm-dialog";'
    b'\nimport { useConfirmDialog } from "@/hooks/use-confirm-dialog";'
)
HOOK = b'\n  const { openConfirm, dialogProps } = useConfirmDialog();'

# ─────────────────────────────────────────────
# admin.tsx: fix deleteOne (wrong closing quote byte was used)
# The file uses „ (0xe2 0x80 0x9e) as left quote but " (0x22) as right quote
# ─────────────────────────────────────────────
def fix_admin(raw):
    raw = rb(raw,
        b'    if (!confirm(`Smazat \xe2\x80\x9e${title}"? Tato akce je nevratn\xc3\xa1.`)) return;\n    deleteJob.mutate({ id }, {\n      onSuccess: () => {\n        invalidateData(queryClient, "jobs");\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setSelected(s => { const n = new Set(s); n.delete(id); return n; });\n      },\n      onError: () => toast({ title: "Smaz\xc3\xa1n\xc3\xad selhalo", variant: "destructive" }),\n    });\n  };',
        b'    openConfirm({ title: `Smazat \xe2\x80\x9e${title}"?`, description: "Tato akce je nevratn\xc3\xa1." }, () => {\n      deleteJob.mutate({ id }, {\n        onSuccess: () => {\n          invalidateData(queryClient, "jobs");\n          toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n          setSelected(s => { const n = new Set(s); n.delete(id); return n; });\n        },\n        onError: () => toast({ title: "Smaz\xc3\xa1n\xc3\xad selhalo", variant: "destructive" }),\n      });\n    });\n  };',
        'admin deleteOne')
    # fix deleteSelected close (callback needs closing })
    raw = rb(raw,
        b'      setSelected(new Set());\n  };\n\n  const handleSave',
        b'      setSelected(new Set());\n    });\n  };\n\n  const handleSave',
        'admin deleteSelected close')
    return raw

proc('artifacts/stavba/src/pages/admin.tsx', fix_admin)

# ─────────────────────────────────────────────
# jobs.tsx: add import + hook (confirms already replaced)
# ─────────────────────────────────────────────
def fix_jobs(raw):
    raw = rb(raw,
        b'import { useState, useEffect, useCallback } from "react";',
        b'import { useState, useEffect, useCallback } from "react";' + IMPORT_LINES,
        'jobs import')
    # hook - add after useAuth()
    raw = rb(raw,
        b'  const { user, isAuthenticated } = useAuth();\n',
        b'  const { user, isAuthenticated } = useAuth();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n',
        'jobs hook')
    # JSX - find the Jobs() return end
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'jobs JSX')
    return raw

proc('artifacts/stavba/src/pages/jobs.tsx', fix_jobs)

# ─────────────────────────────────────────────
# billing-document-detail.tsx: add hook + close confirm1 + close handleApply
# ─────────────────────────────────────────────
def fix_billing(raw):
    # add hook after setLocation line
    raw = rb(raw,
        b'  const [, setLocation] = useLocation();\n  const queryClient = useQueryClient();',
        b'  const [, setLocation] = useLocation();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n  const queryClient = useQueryClient();',
        'billing hook')
    # close handleDelete callback - find the specific end
    raw = rb(raw,
        b'          setLocation("/billing/documents");\n        },\n      },\n    );\n  };\n\n  const handleApproveLine',
        b'          setLocation("/billing/documents");\n        },\n      },\n    );\n    });\n  };\n\n  const handleApproveLine',
        'billing confirm1 close')
    # close handleApply callback
    raw = rb(raw,
        b'            variant: "destructive",\n          }),\n      },\n      ),\n    );\n  };\n\n  return (\n    <Card className="mt-6">',
        b'            variant: "destructive",\n          }),\n      },\n    ),\n  );\n  };\n\n  return (\n    <Card className="mt-6">',
        'billing handleApply close fix')
    return raw

proc('artifacts/stavba/src/pages/billing-document-detail.tsx', fix_billing)

# ─────────────────────────────────────────────
# site-detail.tsx: add hook + close confirm callback
# ─────────────────────────────────────────────
def fix_site(raw):
    raw = rb(raw,
        b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n\n  const { data: site',
        b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n' + HOOK + b'\n\n  const { data: site',
        'site hook')
    # close confirm callback
    raw = rb(raw,
        b'          toast({ title: "Dokument smaz\xc3\xa1n" });\n        },\n        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      },\n    );\n  };\n\n  if (!site)',
        b'          toast({ title: "Dokument smaz\xc3\xa1n" });\n        },\n        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      },\n    );\n    });\n  };\n\n  if (!site)',
        'site confirm close')
    return raw

proc('artifacts/stavba/src/pages/site-detail.tsx', fix_site)

# ─────────────────────────────────────────────
# pristupove-udaje.tsx: close confirm callback
# ─────────────────────────────────────────────
def fix_pristupove(raw):
    # Check what the current state is around the deleteCred.mutate area
    # Find the end of the deleteCred.mutate callback
    raw = rb(raw,
        b'          toast({ title: "P\xc5\x99\xc3\xadstup smazan" });\n        },\n        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n  };',
        b'          toast({ title: "P\xc5\x99\xc3\xadstup smazan" });\n        },\n        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n    });\n  };',
        'pristupove confirm close')
    return raw

proc('artifacts/stavba/src/pages/pristupove-udaje.tsx', fix_pristupove)

# ─────────────────────────────────────────────
# customer-detail.tsx: close all 3 confirm callbacks
# ─────────────────────────────────────────────
def fix_cdetail(raw):
    # close handleDeleteCustomer
    raw = rb(raw,
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat z\xc3\xa1kazn\xc3\xadka", variant: "destructive" })\n    });\n  };\n\n  const handleDeleteContact',
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat z\xc3\xa1kazn\xc3\xadka", variant: "destructive" })\n    });\n    });\n  };\n\n  const handleDeleteContact',
        'cdetail confirm1 close')
    # close handleDeleteContact
    raw = rb(raw,
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" })\n    });\n  };\n\n  const handleDeleteSite',
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" })\n    });\n    });\n  };\n\n  const handleDeleteSite',
        'cdetail confirm2 close')
    # close handleDeleteSite
    raw = rb(raw,
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" })\n    });\n  };\n\n  const customer',
        b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" })\n    });\n    });\n  };\n\n  const customer',
        'cdetail confirm3 close')
    return raw

proc('artifacts/stavba/src/pages/customer-detail.tsx', fix_cdetail)

# ─────────────────────────────────────────────
# job-detail.tsx: remaining issues
# - handleDeleteJob confirm (wrong quotes in pattern used before)
# - MaterialsSection hook missing
# - DokladySection hook missing
# ─────────────────────────────────────────────
def fix_jd(raw):
    # handleDeleteJob: file has „ (xe2 80 9e) then " (0x22 ASCII)
    raw = rb(raw,
        b'    if (!confirm(`Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}"? Tato akce je nevratn\xc3\xa1.`)) return;\n    deleteJob.mutate({ id }, {\n      onSuccess: () => {\n        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });\n        invalidateJobLists(queryClient);\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setLocation("/jobs");\n      },\n    });\n  };',
        b'    openConfirmJob({ title: `Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}"?`, description: "Tato akce je nevratn\xc3\xa1." }, () => {\n      deleteJob.mutate({ id }, {\n        onSuccess: () => {\n          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });\n          invalidateJobLists(queryClient);\n          toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n          setLocation("/jobs");\n        },\n      });\n    });\n  };',
        'jd handleDeleteJob confirm')
    # MaterialsSection: hook after function start
    raw = rb(raw,
        b'function MaterialsSection({ jobId, isExpanded, onToggle }: any) {\n  const { data: materials',
        b'function MaterialsSection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsMat } = useConfirmDialog();\n  const { data: materials',
        'jd MaterialsSection hook')
    # DokladySection: hook after function start
    raw = rb(raw,
        b'function DokladySection({ jobId, isExpanded, onToggle }: any) {\n  const fileInputRef',
        b'function DokladySection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsDoc } = useConfirmDialog();\n  const fileInputRef',
        'jd DokladySection hook')
    return raw

proc('artifacts/stavba/src/pages/job-detail.tsx', fix_jd)

# ─────────────────────────────────────────────
# activity-detail.tsx: remaining issues
# - handleDelete (activity) confirm - wrong quote bytes
# - ActivityDetail JSX missing
# - ExtraWorksSection hook + JSX missing
# ─────────────────────────────────────────────
def fix_ad(raw):
    # handleDelete (activity): file has „ (xe2 80 9e) then " (0x22 ASCII)
    raw = rb(raw,
        b'    if (!confirm(`Smazat akci \xe2\x80\x9e${activity.name}"? Sma\xc5\xbeou se i materi\xc3\xa1ly.`)) return;\n    deleteActivity.mutate({ id }, {\n      onSuccess: () => {\n        invalidateData(queryClient, "activities", "warehouse");\n        toast({ title: "Akce smaz\xc3\xa1na" });\n        setLocation("/activities");\n      },\n    });\n  };',
        b'    openConfirmActivity({ title: `Smazat akci \xe2\x80\x9e${activity.name}"?`, description: "Sma\xc5\xbeou se i materi\xc3\xa1ly." }, () => {\n      deleteActivity.mutate({ id }, {\n        onSuccess: () => {\n          invalidateData(queryClient, "activities", "warehouse");\n          toast({ title: "Akce smaz\xc3\xa1na" });\n          setLocation("/activities");\n        },\n      });\n    });\n  };',
        'ad handleDelete confirm')
    # ActivityDetail JSX - add before MaterialsSection function
    raw = rb(raw,
        b'      </div>\n    </div>\n  );\n}\n\nfunction MaterialsSection',
        b'      </div>\n    </div>\n    <ConfirmDialog {...dialogPropsActivity} />\n  );\n}\n\nfunction MaterialsSection',
        'ad ActivityDetail JSX')
    # ExtraWorksSection: add hook
    raw = rb(raw,
        b'function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const { toast } = useToast();\n  const queryClient',
        b'function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const { openConfirm, dialogProps: dialogPropsWork } = useConfirmDialog();\n  const { toast } = useToast();\n  const queryClient',
        'ad ExtraWorksSection hook')
    # ExtraWorksSection JSX - fix the wrong dialogPropsPhoto that was put there
    raw = rb(raw,
        b'    </Card>\n    <ConfirmDialog {...dialogPropsPhoto} />\n  );\n}\n\nfunction ActivityTimeEntries',
        b'    </Card>\n    <ConfirmDialog {...dialogPropsWork} />\n  );\n}\n\nfunction ActivityTimeEntries',
        'ad ExtraWorksSection JSX fix')
    return raw

proc('artifacts/stavba/src/pages/activity-detail.tsx', fix_ad)

# ─────────────────────────────────────────────
# Remaining JSX additions for sklad/people/customers/activities/users-admin/stroj/gdpr
# (hooks already added, just need ConfirmDialog in JSX)
# ─────────────────────────────────────────────

# stroj-detail.tsx: add hook + JSX
def fix_stroj(raw):
    raw = rb(raw,
        b'  const { can } = useAuth();\n\n  const [qrUrl',
        b'  const { can } = useAuth();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n\n  const [qrUrl',
        'stroj hook')
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'stroj JSX')
    return raw

proc('artifacts/stavba/src/pages/stroj-detail.tsx', fix_stroj)

# users-admin.tsx: add hook + JSX
def fix_users(raw):
    raw = rb(raw,
        b'  const { user: me } = useAuth();\n  const queryClient = useQueryClient();\n  const { toast } = useToast();',
        b'  const { user: me } = useAuth();\n  const queryClient = useQueryClient();\n  const { toast } = useToast();\n  const { openConfirm, dialogProps } = useConfirmDialog();',
        'users hook')
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'users JSX')
    return raw

proc('artifacts/stavba/src/pages/users-admin.tsx', fix_users)

# sklad.tsx: JSX
def fix_sklad(raw):
    raw = rb(raw,
        b'\n      {historyItem && (',
        b'\n      <ConfirmDialog {...dialogProps} />\n      {historyItem && (',
        'sklad JSX')
    return raw

proc('artifacts/stavba/src/pages/sklad.tsx', fix_sklad)

# people.tsx: JSX
def fix_people(raw):
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'people JSX')
    return raw

proc('artifacts/stavba/src/pages/people.tsx', fix_people)

# customers.tsx: JSX  
def fix_customers(raw):
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'customers JSX')
    return raw

proc('artifacts/stavba/src/pages/customers.tsx', fix_customers)

# activities.tsx: JSX
def fix_activities(raw):
    raw = rb(raw,
        b'\n    </div>\n  );\n}\n',
        b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
        'activities JSX')
    return raw

proc('artifacts/stavba/src/pages/activities.tsx', fix_activities)

# gdpr.tsx: verify JSX (was added before)
def fix_gdpr(raw):
    if b'<ConfirmDialog' not in raw:
        raw = rb(raw,
            b'\n    </div>\n  );\n}\n',
            b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
            'gdpr JSX')
    return raw

proc('artifacts/stavba/src/pages/gdpr.tsx', fix_gdpr)

print("\nAll done!")
