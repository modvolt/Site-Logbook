"""
Final targeted fixes for all remaining confirm() callback closure issues.
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
    changed = "OK" if raw2 != raw else "NO CHANGE"
    print(f"{changed} {filepath}")

# ─────────────────────────────────────────────
# admin.tsx: close deleteSelected callback
# ─────────────────────────────────────────────
def fix_admin(raw):
    raw = rb(raw,
        b'    toast({ title: `Smaz\xc3\xa1no ${ok}, selhalo ${fail}` });\n  };\n\n  const toggleSelect',
        b'    toast({ title: `Smaz\xc3\xa1no ${ok}, selhalo ${fail}` });\n    });\n  };\n\n  const toggleSelect',
        'admin deleteSelected close')
    return raw

proc('artifacts/stavba/src/pages/admin.tsx', fix_admin)

# ─────────────────────────────────────────────
# jobs.tsx: add hook (after useAuth)
# ─────────────────────────────────────────────
def fix_jobs(raw):
    raw = rb(raw,
        b'  const { isAuthenticated } = useAuth();\n  const queryClient',
        b'  const { isAuthenticated } = useAuth();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n  const queryClient',
        'jobs hook')
    return raw

proc('artifacts/stavba/src/pages/jobs.tsx', fix_jobs)

# ─────────────────────────────────────────────
# billing-document-detail.tsx: close handleDelete callback
# ─────────────────────────────────────────────
def fix_billing(raw):
    raw = rb(raw,
        b'      },\n    );\n  };\n\n  const fileHref',
        b'      },\n    );\n    });\n  };\n\n  const fileHref',
        'billing handleDelete close')
    return raw

proc('artifacts/stavba/src/pages/billing-document-detail.tsx', fix_billing)

# ─────────────────────────────────────────────
# site-detail.tsx: close handleDelete callback
# ─────────────────────────────────────────────
def fix_site(raw):
    raw = rb(raw,
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat dokument", variant: "destructive" }),\n      }\n    );\n  };\n\n  if (!site)',
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat dokument", variant: "destructive" }),\n      }\n    );\n    });\n  };\n\n  if (!site)',
        'site handleDelete close')
    return raw

proc('artifacts/stavba/src/pages/site-detail.tsx', fix_site)

# ─────────────────────────────────────────────
# pristupove-udaje.tsx: close handleDelete callback
# ─────────────────────────────────────────────
def fix_pristupove(raw):
    raw = rb(raw,
        b'        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n  };\n\n  const copy',
        b'        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n    });\n  };\n\n  const copy',
        'pristupove handleDelete close')
    return raw

proc('artifacts/stavba/src/pages/pristupove-udaje.tsx', fix_pristupove)

# ─────────────────────────────────────────────
# customer-detail.tsx: close all 3 callbacks
# ─────────────────────────────────────────────
def fix_cdetail(raw):
    # handleDelete (customer)
    raw = rb(raw,
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      }\n    );\n  };\n\n  // --- Contacts handlers ---',
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      }\n    );\n    });\n  };\n\n  // --- Contacts handlers ---',
        'cdetail customer close')
    # handleDeleteContact
    raw = rb(raw,
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" }),\n      }\n    );\n  };\n\n  // --- Sites handlers ---',
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" }),\n      }\n    );\n    });\n  };\n\n  // --- Sites handlers ---',
        'cdetail contact close')
    # handleDeleteSite
    raw = rb(raw,
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" }),\n      }\n    );\n  };\n\n  if (loadingCustomer)',
        b'        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" }),\n      }\n    );\n    });\n  };\n\n  if (loadingCustomer)',
        'cdetail site close')
    return raw

proc('artifacts/stavba/src/pages/customer-detail.tsx', fix_cdetail)

# ─────────────────────────────────────────────
# job-detail.tsx: handleDeleteJob (has onError block)
# ─────────────────────────────────────────────
def fix_jd(raw):
    raw = rb(raw,
        b'    if (!confirm(`Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}"? Tato akce je nevratn\xc3\xa1.`)) return;\n    deleteJob.mutate({ id }, {\n      onSuccess: () => {\n        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });\n        invalidateJobLists(queryClient);\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setLocation("/jobs");\n      },\n      onError: () => {\n        toast({ title: "Nepoda\xc5\x99ilo se smazat zak\xc3\xa1zku", variant: "destructive" });\n      }\n    });\n  };',
        b'    openConfirmJob({ title: `Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}"?`, description: "Tato akce je nevratn\xc3\xa1." }, () => {\n      deleteJob.mutate({ id }, {\n        onSuccess: () => {\n          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(id) });\n          invalidateJobLists(queryClient);\n          toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n          setLocation("/jobs");\n        },\n        onError: () => {\n          toast({ title: "Nepoda\xc5\x99ilo se smazat zak\xc3\xa1zku", variant: "destructive" });\n        }\n      });\n    });\n  };',
        'jd handleDeleteJob')
    return raw

proc('artifacts/stavba/src/pages/job-detail.tsx', fix_jd)

# ─────────────────────────────────────────────
# activity-detail.tsx:
# 1. ActivityDetail JSX (comes just before `type Material =`)
# 2. Fix ExtraWorksSection JSX (wrong dialogPropsPhoto → dialogPropsWork)
# ─────────────────────────────────────────────
def fix_ad(raw):
    # ActivityDetail JSX: ends with `    </div>\n  );\n}\n\ntype Material`
    raw = rb(raw,
        b'    </div>\n  );\n}\n\ntype Material',
        b'    </div>\n    <ConfirmDialog {...dialogPropsActivity} />\n  );\n}\n\ntype Material',
        'ad ActivityDetail JSX')
    # Fix ExtraWorksSection JSX: replace wrong dialogPropsPhoto with dialogPropsWork
    # This is the `</Card>` before ActivityTimeEntries
    raw = rb(raw,
        b'    </Card>\n    <ConfirmDialog {...dialogPropsPhoto} />\n  );\n}\n\nfunction ActivityTimeEntries',
        b'    </Card>\n    <ConfirmDialog {...dialogPropsWork} />\n  );\n}\n\nfunction ActivityTimeEntries',
        'ad ExtraWorksSection JSX fix')
    return raw

proc('artifacts/stavba/src/pages/activity-detail.tsx', fix_ad)

print("\nAll done!")
