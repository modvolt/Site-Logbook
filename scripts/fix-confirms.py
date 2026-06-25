"""
Replace all browser confirm() calls with openConfirm() hook pattern.
Run from workspace root: python3 scripts/fix-confirms.py
"""
import sys

def rb(raw, old, new, label=""):
    if old in raw:
        return raw.replace(old, new, 1)
    print(f"  NOT FOUND [{label}]")
    return raw

def proc(filepath, fn):
    with open(filepath, 'rb') as f:
        raw = f.read()
    raw2 = fn(raw)
    if raw2 != raw:
        with open(filepath, 'wb') as f:
            f.write(raw2)
        print(f"OK {filepath}")
    else:
        print(f"NO CHANGE {filepath}")

IMPORT_LINES = (
    b'\nimport { ConfirmDialog } from "@/components/confirm-dialog";'
    b'\nimport { useConfirmDialog } from "@/hooks/use-confirm-dialog";'
)

# ──────────────────────────────────────────
# admin.tsx
# ──────────────────────────────────────────
def fix_admin(raw):
    # imports
    raw = rb(raw, b'import { useState, useMemo } from "react";',
             b'import { useState, useMemo } from "react";' + IMPORT_LINES, 'admin import')
    # hook
    raw = rb(raw,
             b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n  const [search',
             b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n  const [search',
             'admin hook')
    # deleteOne: replace confirm + fix indentation of body + add closing })
    raw = rb(raw,
             b'    if (!confirm(`Smazat \xe2\x80\x9e${title}\xe2\x80\x9c? Tato akce je nevratn\xc3\xa1.`)) return;\n    deleteJob.mutate({ id }, {\n      onSuccess: () => {\n        invalidateData(queryClient, "jobs");\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setSelected(s => { const n = new Set(s); n.delete(id); return n; });\n      },\n      onError: () => toast({ title: "Smaz\xc3\xa1n\xc3\xad selhalo", variant: "destructive" }),\n    });\n  };',
             b'    openConfirm({ title: `Smazat \xe2\x80\x9e${title}\xe2\x80\x9c?`, description: "Tato akce je nevratn\xc3\xa1." }, () => {\n      deleteJob.mutate({ id }, {\n        onSuccess: () => {\n          invalidateData(queryClient, "jobs");\n          toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n          setSelected(s => { const n = new Set(s); n.delete(id); return n; });\n        },\n        onError: () => toast({ title: "Smaz\xc3\xa1n\xc3\xad selhalo", variant: "destructive" }),\n      });\n    });\n  };',
             'admin deleteOne')
    # deleteSelected: replace confirm + open callback
    raw = rb(raw,
             b'    if (!confirm(`Smazat ${selected.size} zak\xc3\xa1zek? Tato akce je nevratn\xc3\xa1.`)) return;\n    let ok = 0',
             b'    openConfirm({ title: `Smazat ${selected.size} zak\xc3\xa1zek?`, description: "Tato akce je nevratn\xc3\xa1." }, async () => {\n    let ok = 0',
             'admin deleteSelected confirm')
    # close the callback of deleteSelected (before handleSave)
    raw = rb(raw,
             b'      setSelected(new Set());\n  };\n\n  const handleSave',
             b'      setSelected(new Set());\n    });\n  };\n\n  const handleSave',
             'admin deleteSelected close')
    # JSX: add dialog before last </div> before );
    raw = rb(raw,
             b'\n    </div>\n  );\n}\n',
             b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
             'admin JSX')
    return raw

proc('artifacts/stavba/src/pages/admin.tsx', fix_admin)

# ──────────────────────────────────────────
# jobs.tsx
# ──────────────────────────────────────────
def fix_jobs(raw):
    # imports
    raw = rb(raw, b'import { useState } from "react";\nimport { Link } from "wouter";',
             b'import { useState } from "react";\nimport { Link } from "wouter";' + IMPORT_LINES, 'jobs import')
    # find hook insertion point - after useAuth()
    raw = rb(raw,
             b'  const { user, isAuthenticated } = useAuth();\n\n  const [orderedSelected',
             b'  const { user, isAuthenticated } = useAuth();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n\n  const [orderedSelected',
             'jobs hook')
    # handleSavePreset: replace window.confirm (overwrite existing preset)
    raw = rb(raw,
             b'      const ok = window.confirm(`P\xc5\x99edvolba "${trimmed}" u\xc5\xbe existuje. P\xc5\x99epsat?`);\n      if (!ok) return;\n      const next = presets.map(p =>\n        p.id === existing.id ? { ...p, columns: [...orderedSelected] } : p\n      );\n      persistPresets(next);\n      setActivePresetId(existing.id);\n      return;',
             b'      openConfirm({ title: `P\xc5\x99edvolba "${trimmed}" u\xc5\xbe existuje.`, confirmLabel: "P\xc5\x99epsat", destructive: false }, () => {\n        const next = presets.map(p =>\n          p.id === existing.id ? { ...p, columns: [...orderedSelected] } : p\n        );\n        persistPresets(next);\n        setActivePresetId(existing.id);\n      });\n      return;',
             'jobs savePreset confirm')
    # handleDeletePreset: replace window.confirm
    raw = rb(raw,
             b'    const ok = window.confirm(`Smazat p\xc5\x99edvolbu "${preset.name}"?`);\n    if (!ok) return;\n    persistPresets(presets.filter(p => p.id !== preset.id));\n    setActivePresetId("");',
             b'    openConfirm(`Smazat p\xc5\x99edvolbu "${preset.name}"?`, () => {\n      persistPresets(presets.filter(p => p.id !== preset.id));\n      setActivePresetId("");\n    });',
             'jobs deletePreset confirm')
    # JSX: add dialog - jobs.tsx ends differently, find the export's last </div>
    # The return statement of Jobs() - add before last </div>
    raw = rb(raw,
             b'        </div>\n      </div>\n    </div>\n  );\n}',
             b'        </div>\n      </div>\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}',
             'jobs JSX')
    return raw

proc('artifacts/stavba/src/pages/jobs.tsx', fix_jobs)

# ──────────────────────────────────────────
# gdpr.tsx - confirm already done, add JSX
# ──────────────────────────────────────────
def fix_gdpr_jsx(raw):
    # The JSX edit we did earlier may have created a wrong pattern. Check and fix.
    # Looking for the specific pattern at the end
    if b'<ConfirmDialog {...dialogProps} />' not in raw:
        raw = rb(raw,
                 b'      </div>\n    </div>\n  );\n}',
                 b'      </div>\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}',
                 'gdpr JSX')
    return raw

proc('artifacts/stavba/src/pages/gdpr.tsx', fix_gdpr_jsx)

# ──────────────────────────────────────────
# pristupove-udaje.tsx
# ──────────────────────────────────────────
def fix_pristupove(raw):
    raw = rb(raw, b'import { useMemo, useRef, useState } from "react";',
             b'import { useMemo, useRef, useState } from "react";' + IMPORT_LINES, 'pristupove import')
    raw = rb(raw,
             b'  const { toast } = useToast();\n  const [, setLocation] = useLocation();\n\n  const [customerId',
             b'  const { toast } = useToast();\n  const [, setLocation] = useLocation();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n\n  const [customerId',
             'pristupove hook')
    raw = rb(raw,
             b'    if (!confirm("Opravdu smazat tento p\xc5\x99\xc3\xadstup?")) return;\n    deleteCred.mutate(',
             b'    openConfirm("Opravdu smazat tento p\xc5\x99\xc3\xadstup?", () => {\n      deleteCred.mutate(',
             'pristupove confirm')
    # close the callback - find end of deleteCred.mutate
    raw = rb(raw,
             b'          toast({ title: "P\xc5\x99\xc3\xadstup smazan" });\n        },\n        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n  };',
             b'          toast({ title: "P\xc5\x99\xc3\xadstup smazan" });\n        },\n        onError: () =>\n          toast({ title: "Nepoda\xc5\x99ilo se smazat p\xc5\x99\xc3\xadstup", variant: "destructive" }),\n      },\n    );\n    });\n  };',
             'pristupove confirm close')
    # JSX: add before BarcodeScanner
    raw = rb(raw,
             b'\n      <BarcodeScanner\n        open={scannerOpen}',
             b'\n      <ConfirmDialog {...dialogProps} />\n      <BarcodeScanner\n        open={scannerOpen}',
             'pristupove JSX')
    return raw

proc('artifacts/stavba/src/pages/pristupove-udaje.tsx', fix_pristupove)

# ──────────────────────────────────────────
# customer-detail.tsx
# ──────────────────────────────────────────
def fix_customer_detail(raw):
    raw = rb(raw, b'import { useState } from "react";\nimport { useParams',
             b'import { useState } from "react";\nimport { useParams' + b'\nimport { ConfirmDialog } from "@/components/confirm-dialog";\nimport { useConfirmDialog } from "@/hooks/use-confirm-dialog";',
             'cdetail import')
    raw = rb(raw,
             b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n\n  const { data: customers',
             b'  const queryClient = useQueryClient();\n  const { toast } = useToast();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n\n  const { data: customers',
             'cdetail hook')
    # delete customer
    raw = rb(raw,
             b'    if (!confirm("Opravdu smazat z\xc3\xa1kazn\xc3\xadka?")) return;\n    deleteCustomer.mutate(',
             b'    openConfirm("Opravdu smazat z\xc3\xa1kazn\xc3\xadka?", () => {\n      deleteCustomer.mutate(',
             'cdetail confirm1')
    raw = rb(raw,
             b'        toast({ title: "Z\xc3\xa1kazn\xc3\xadk smazan" });\n        navigate("/customers");\n      },\n      onError',
             b'        toast({ title: "Z\xc3\xa1kazn\xc3\xadk smazan" });\n        navigate("/customers");\n      },\n      onError',
             'cdetail check1')
    # fix: need to close the callback properly. Let me find the pattern
    raw = rb(raw,
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat z\xc3\xa1kazn\xc3\xadka", variant: "destructive" })\n    });\n  };\n\n  const handleDeleteContact',
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat z\xc3\xa1kazn\xc3\xadka", variant: "destructive" })\n    });\n    });\n  };\n\n  const handleDeleteContact',
             'cdetail confirm1 close')
    # delete contact
    raw = rb(raw,
             b'    if (!confirm("Opravdu smazat kontakt?")) return;\n    deleteContact.mutate(',
             b'    openConfirm("Opravdu smazat kontakt?", () => {\n      deleteContact.mutate(',
             'cdetail confirm2')
    raw = rb(raw,
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" })\n    });\n  };\n\n  const handleDeleteSite',
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat kontakt", variant: "destructive" })\n    });\n    });\n  };\n\n  const handleDeleteSite',
             'cdetail confirm2 close')
    # delete site
    raw = rb(raw,
             b'    if (!confirm("Opravdu smazat stavbu?")) return;\n    deleteSite.mutate(',
             b'    openConfirm("Opravdu smazat stavbu?", () => {\n      deleteSite.mutate(',
             'cdetail confirm3')
    raw = rb(raw,
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" })\n    });\n  };\n\n  const customer',
             b'      onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat stavbu", variant: "destructive" })\n    });\n    });\n  };\n\n  const customer',
             'cdetail confirm3 close')
    # JSX
    raw = rb(raw,
             b'\n    </div>\n  );\n}\n',
             b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
             'cdetail JSX')
    return raw

proc('artifacts/stavba/src/pages/customer-detail.tsx', fix_customer_detail)

# ──────────────────────────────────────────
# billing-document-detail.tsx
# ──────────────────────────────────────────
def fix_billing(raw):
    raw = rb(raw, b'import { useState } from "react";\nimport { useLocation',
             b'import { useState } from "react";\nimport { useLocation' + b'\nimport { ConfirmDialog } from "@/components/confirm-dialog";\nimport { useConfirmDialog } from "@/hooks/use-confirm-dialog";',
             'billing import')
    # hook - add after invalidateData import block, find component start
    raw = rb(raw,
             b'export default function BillingDocumentDetail() {\n  const [, setLocation] = useLocation();',
             b'export default function BillingDocumentDetail() {\n  const [, setLocation] = useLocation();\n  const { openConfirm, dialogProps } = useConfirmDialog();',
             'billing hook')
    # handleDelete confirm
    raw = rb(raw,
             b'    if (!confirm("Opravdu smazat tento doklad? Tuto akci nelze vr\xc3\xa1tit.")) return;\n    deleteDoc.mutate(',
             b'    openConfirm("Opravdu smazat tento doklad? Tuto akci nelze vr\xc3\xa1tit.", () => {\n      deleteDoc.mutate(',
             'billing confirm1')
    raw = rb(raw,
             b'          toast({ title: "Doklad smazan" });\n          setLocation("/billing/documents");\n        },\n        onSuccess',
             b'          toast({ title: "Doklad smazan" });\n          setLocation("/billing/documents");\n        },\n        onSuccess',
             'billing check confirm1')
    # close callback for handleDelete
    raw = rb(raw,
             b'          setLocation("/billing/documents");\n        },\n      },\n    );\n  };\n\n  const handleApproveLine',
             b'          setLocation("/billing/documents");\n        },\n      },\n    );\n    });\n  };\n\n  const handleApproveLine',
             'billing confirm1 close')
    # handleApply: the complex multi-line if(!confirm(...))
    raw = rb(raw,
             b'  const handleApply = () => {\n    if (\n      !confirm(\n        "P\xc5\x99en\xc3\xa9st n\xc3\xa1kupn\xc3\xad ceny z polo\xc5\xbeek tohoto dokladu do skladu? Aktualizuj\xc3\xad se ceny odpov\xc3\xaddaj\xc3\xadc\xc3\xadch skladov\xc3\xbdch karet a chyb\xc4\x9bj\xc3\xadc\xc3\xad se automaticky zalo\xc5\xbe\xc3\xad.",\n      )\n    )\n      return;\n    apply.mutate(',
             b'  const handleApply = () => {\n    openConfirm(\n      {\n        title: "P\xc5\x99en\xc3\xa9st n\xc3\xa1kupn\xc3\xad ceny do skladu?",\n        description: "Aktualizuj\xc3\xad se ceny odpov\xc3\xaddaj\xc3\xadc\xc3\xadch skladov\xc3\xbdch karet a chyb\xc4\x9bj\xc3\xadc\xc3\xad se automaticky zalo\xc5\xbe\xc3\xad.",\n        confirmLabel: "P\xc5\x99en\xc3\xa9st",\n      },\n      () => apply.mutate(',
             'billing handleApply confirm')
    # close handleApply callback - find end
    raw = rb(raw,
             b'            variant: "destructive",\n          }),\n      },\n    );\n  };\n\n  return (\n    <Card className="mt-6">',
             b'            variant: "destructive",\n          }),\n      },\n      ),\n    );\n  };\n\n  return (\n    <Card className="mt-6">',
             'billing handleApply close')
    # JSX for the main BillingDocumentDetail component - it's large, add near end
    # The file ends with the main return. Add dialog near the end.
    # Find the pattern for the last wrapper div end
    raw = rb(raw,
             b'\n    </div>\n  );\n}\n',
             b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
             'billing JSX')
    return raw

proc('artifacts/stavba/src/pages/billing-document-detail.tsx', fix_billing)

# ──────────────────────────────────────────
# site-detail.tsx
# ──────────────────────────────────────────
def fix_site_detail(raw):
    raw = rb(raw, b'import { useRef, useState } from "react";',
             b'import { useRef, useState } from "react";' + IMPORT_LINES, 'site import')
    raw = rb(raw,
             b'  const queryClient = useQueryClient();\n  const { upload',
             b'  const queryClient = useQueryClient();\n  const { openConfirm, dialogProps } = useConfirmDialog();\n  const { upload',
             'site hook')
    raw = rb(raw,
             b'    if (!confirm("Smazat tento dokument?")) return;\n    deleteAttachment.mutate(',
             b'    openConfirm("Smazat tento dokument?", () => {\n      deleteAttachment.mutate(',
             'site confirm')
    raw = rb(raw,
             b'          toast({ title: "Dokument smaz\xc3\xa1n" });\n        },\n        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      },\n    );\n  };\n\n  if (!site)',
             b'          toast({ title: "Dokument smaz\xc3\xa1n" });\n        },\n        onError: () => toast({ title: "Nepoda\xc5\x99ilo se smazat", variant: "destructive" }),\n      },\n    );\n    });\n  };\n\n  if (!site)',
             'site confirm close')
    # JSX
    raw = rb(raw,
             b'\n    </div>\n  );\n}\n',
             b'\n    </div>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n',
             'site JSX')
    return raw

proc('artifacts/stavba/src/pages/site-detail.tsx', fix_site_detail)

# ──────────────────────────────────────────
# time-entries-section.tsx (component)
# ──────────────────────────────────────────
def fix_time_entries(raw):
    raw = rb(raw, b'import { useState, useEffect } from "react";',
             b'import { useState, useEffect } from "react";\nimport { ConfirmDialog } from "@/components/confirm-dialog";\nimport { useConfirmDialog } from "@/hooks/use-confirm-dialog";',
             'time import')
    # Hook inside TimeEntriesSection
    raw = rb(raw,
             b'  const [now, setNow] = useState(() => Date.now());\n  const [adding, setAdding] = useState(false);',
             b'  const [now, setNow] = useState(() => Date.now());\n  const [adding, setAdding] = useState(false);\n  const { openConfirm, dialogProps } = useConfirmDialog();',
             'time hook')
    # inline confirm in onClick
    raw = rb(raw,
             b'onClick={() => { if (confirm(`Odebrat ${e.personName} z evidence \xc4\x8dasu?`)) onRemove(e.personId); }}',
             b'onClick={() => openConfirm(`Odebrat ${e.personName} z evidence \xc4\x8dasu?`, () => onRemove(e.personId))}',
             'time confirm')
    # JSX: add before </CardContent>
    raw = rb(raw,
             b'\n      </CardContent>\n    </Card>\n  );\n}',
             b'\n      </CardContent>\n      <ConfirmDialog {...dialogProps} />\n    </Card>\n  );\n}',
             'time JSX')
    return raw

proc('artifacts/stavba/src/components/time-entries-section.tsx', fix_time_entries)

# ──────────────────────────────────────────
# job-detail.tsx (multiple sub-components)
# ──────────────────────────────────────────
def fix_job_detail(raw):
    raw = rb(raw, b'import { useState, useRef, useCallback, useEffect } from "react";',
             b'import { useState, useRef, useCallback, useEffect } from "react";' + IMPORT_LINES, 'jd import')

    # JobDetail: add hook
    raw = rb(raw,
             b'export default function JobDetail() {\n  const params',
             b'export default function JobDetail() {\n  const { openConfirm: openConfirmJob, dialogProps: dialogPropsJob } = useConfirmDialog();\n  const params',
             'jd JobDetail hook')
    # JobDetail: handleDeleteJob confirm
    raw = rb(raw,
             b'    if (!confirm(`Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}\xe2\x80\x9c? Tato akce je nevratn\xc3\xa1.`)) return;\n    deleteJob.mutate({ id }, {',
             b'    openConfirmJob({ title: `Opravdu smazat zak\xc3\xa1zku \xe2\x80\x9e${job?.title}\xe2\x80\x9c?`, description: "Tato akce je nevratn\xc3\xa1." }, () => {\n      deleteJob.mutate({ id }, {',
             'jd handleDeleteJob confirm')
    # close handleDeleteJob callback
    raw = rb(raw,
             b'        invalidateJobLists(queryClient);\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setLocation("/jobs");\n      },\n    });\n  };\n\n  const handleUpdateStatus',
             b'        invalidateJobLists(queryClient);\n        toast({ title: "Zak\xc3\xa1zka smaz\xc3\xa1na" });\n        setLocation("/jobs");\n      },\n      });\n    });\n  };\n\n  const handleUpdateStatus',
             'jd handleDeleteJob close')
    # JobDetail JSX: find unique ending pattern of JobDetail function
    # JobDetail ends when StatusDropdown starts (line 369 = next function)
    # Actually we need to find the return statement of JobDetail and add dialog there
    # The JobDetail return includes <div ...> ... </div> before ); }
    # Use a unique pattern near the end of JobDetail's return
    raw = rb(raw,
             b'      </div>\n    </div>\n  );\n}\n\nfunction StatusDropdown',
             b'      </div>\n    </div>\n    <ConfirmDialog {...dialogPropsJob} />\n  );\n}\n\nfunction StatusDropdown',
             'jd JobDetail JSX')

    # TasksSection: add hook
    raw = rb(raw,
             b'function TasksSection({ jobId, isExpanded, onToggle }: any) {\n  const { data: tasks',
             b'function TasksSection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps } = useConfirmDialog();\n  const { data: tasks',
             'jd TasksSection hook')
    # TasksSection: handleDeleteTask confirm
    raw = rb(raw,
             b'    if (!confirm("Smazat tento \xc3\xbakol?")) return;\n    deleteTask.mutate({ jobId, taskId }, {',
             b'    openConfirm("Smazat tento \xc3\xbakol?", () => {\n      deleteTask.mutate({ jobId, taskId }, {',
             'jd TasksSection confirm')
    raw = rb(raw,
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })\n    });\n  };\n\n  const handleUpdateTask',
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(jobId) })\n      });\n    });\n  };\n\n  const handleUpdateTask',
             'jd TasksSection confirm close')
    # TasksSection JSX - find its ending before JobTimeEntries function
    raw = rb(raw,
             b'  );\n}\n\nfunction JobTimeEntries',
             b'  );\n}\n\nfunction JobTimeEntries',
             'jd TasksSection JSX check') # can't easily add here without more context
    # Actually add dialog inside TasksSection return - find unique pattern
    raw = rb(raw,
             b'    </SectionCard>\n  );\n}\n\nfunction JobTimeEntries',
             b'    </SectionCard>\n    <ConfirmDialog {...dialogProps} />\n  );\n}\n\nfunction JobTimeEntries',
             'jd TasksSection JSX')

    # MaterialsSection: add hook
    raw = rb(raw,
             b'function MaterialsSection({ jobId, isExpanded, onToggle }: any) {\n  const queryClient',
             b'function MaterialsSection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsMat } = useConfirmDialog();\n  const queryClient',
             'jd MaterialsSection hook')
    # MaterialsSection: handleDelete confirm
    raw = rb(raw,
             b'    if (!confirm("Smazat materi\xc3\xa1l?")) return;\n    deleteMaterial.mutate({ jobId, materialId }, {',
             b'    openConfirm("Smazat materi\xc3\xa1l?", () => {\n      deleteMaterial.mutate({ jobId, materialId }, {',
             'jd MaterialsSection confirm')
    raw = rb(raw,
             b'        toast({ title: "Materi\xc3\xa1l odstran\xc4\x9bn" });\n      }\n    });\n  };\n\n  const',
             b'        toast({ title: "Materi\xc3\xa1l odstran\xc4\x9bn" });\n      }\n      });\n    });\n  };\n\n  const',
             'jd MaterialsSection confirm close')
    raw = rb(raw,
             b'    </SectionCard>\n  );\n}\n\nfunction TaskRow',
             b'    </SectionCard>\n    <ConfirmDialog {...dialogPropsMat} />\n  );\n}\n\nfunction TaskRow',
             'jd MaterialsSection JSX')

    # DokladySection: add hook
    raw = rb(raw,
             b'function DokladySection({ jobId, isExpanded, onToggle }: any) {\n  const queryClient',
             b'function DokladySection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsDoc } = useConfirmDialog();\n  const queryClient',
             'jd DokladySection hook')
    # DokladySection: handleDelete confirm (doklad)
    raw = rb(raw,
             b'    if (!confirm("Smazat tento doklad?")) return;\n    deleteAttachment.mutate({ jobId, attachmentId: id }, {',
             b'    openConfirm("Smazat tento doklad?", () => {\n      deleteAttachment.mutate({ jobId, attachmentId: id }, {',
             'jd DokladySection confirm')
    raw = rb(raw,
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n    });\n  };\n\n  return (\n    <SectionCard',
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n      });\n    });\n  };\n\n  return (\n    <SectionCard',
             'jd DokladySection confirm close')
    raw = rb(raw,
             b'    </SectionCard>\n  );\n}\n\nfunction JobSheetsSection',
             b'    </SectionCard>\n    <ConfirmDialog {...dialogPropsDoc} />\n  );\n}\n\nfunction JobSheetsSection',
             'jd DokladySection JSX')

    # JobSheetsSection: add hook
    raw = rb(raw,
             b'function JobSheetsSection({ jobId, isExpanded, onToggle }: any) {\n  const',
             b'function JobSheetsSection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsSheet } = useConfirmDialog();\n  const',
             'jd JobSheetsSection hook')
    # JobSheetsSection: handleDelete confirm (zakázkový list)
    raw = rb(raw,
             b'    if (!confirm("Smazat tento zak\xc3\xa1zkov\xc3\xbd list?")) return;\n    deleteAttachment.mutate({ jobId, attachmentId: id }, {',
             b'    openConfirm("Smazat tento zak\xc3\xa1zkov\xc3\xbd list?", () => {\n      deleteAttachment.mutate({ jobId, attachmentId: id }, {',
             'jd JobSheetsSection confirm')
    # Need to close the callback for JobSheetsSection - there are two sections that both use
    # deleteAttachment.mutate - need different context
    # After JobSheetsSection's handleDelete, there's a return with <SectionCard
    # The pattern after the close should be unique to JobSheetsSection
    # There are TWO `onSuccess: () => queryClient.invalidateQueries... });\n  };\n\n  return (\n    <SectionCard`
    # One in DokladySection (already fixed) and one in JobSheetsSection
    # Since DokladySection is already fixed, this one is unambiguous
    raw = rb(raw,
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n    });\n  };\n\n  return (\n    <SectionCard',
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n      });\n    });\n  };\n\n  return (\n    <SectionCard',
             'jd JobSheetsSection confirm close')
    raw = rb(raw,
             b'    </SectionCard>\n  );\n}\n\nfunction AttachmentsSection',
             b'    </SectionCard>\n    <ConfirmDialog {...dialogPropsSheet} />\n  );\n}\n\nfunction AttachmentsSection',
             'jd JobSheetsSection JSX')

    # AttachmentsSection (photos): add hook
    raw = rb(raw,
             b'function AttachmentsSection({ jobId, isExpanded, onToggle }: any) {\n  const',
             b'function AttachmentsSection({ jobId, isExpanded, onToggle }: any) {\n  const { openConfirm, dialogProps: dialogPropsPhoto } = useConfirmDialog();\n  const',
             'jd AttachmentsSection hook')
    # handleDelete confirm (photo)
    raw = rb(raw,
             b'    if (!confirm("Smazat tuto fotografii?")) return;\n    deleteAttachment.mutate({ jobId, attachmentId }, {',
             b'    openConfirm("Smazat tuto fotografii?", () => {\n      deleteAttachment.mutate({ jobId, attachmentId }, {',
             'jd AttachmentsSection confirm')
    raw = rb(raw,
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n    });\n  };\n\n  const photos',
             b'      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(jobId) })\n      });\n    });\n  };\n\n  const photos',
             'jd AttachmentsSection confirm close')
    # AttachmentsSection JSX - ends before WorkSummarySection
    raw = rb(raw,
             b'    </SectionCard>\n  );\n}\n\nfunction WorkSummarySection',
             b'    </SectionCard>\n    <ConfirmDialog {...dialogPropsPhoto} />\n  );\n}\n\nfunction WorkSummarySection',
             'jd AttachmentsSection JSX')

    return raw

proc('artifacts/stavba/src/pages/job-detail.tsx', fix_job_detail)

# ──────────────────────────────────────────
# activity-detail.tsx (multiple sub-components)
# ──────────────────────────────────────────
def fix_activity_detail(raw):
    raw = rb(raw, b'import { useState, useEffect, useRef } from "react";',
             b'import { useState, useEffect, useRef } from "react";' + IMPORT_LINES, 'ad import')

    # ActivityDetail: add hook
    raw = rb(raw,
             b'export default function ActivityDetail() {\n  const params',
             b'export default function ActivityDetail() {\n  const { openConfirm: openConfirmActivity, dialogProps: dialogPropsActivity } = useConfirmDialog();\n  const params',
             'ad ActivityDetail hook')
    # handleDelete (delete activity)
    raw = rb(raw,
             b'    if (!confirm(`Smazat akci \xe2\x80\x9e${activity.name}\xe2\x80\x9c? Sma\xc5\xbeou se i materi\xc3\xa1ly.`)) return;\n    deleteActivity.mutate({ id }, {',
             b'    openConfirmActivity({ title: `Smazat akci \xe2\x80\x9e${activity.name}\xe2\x80\x9c?`, description: "Sma\xc5\xbeou se i materi\xc3\xa1ly." }, () => {\n      deleteActivity.mutate({ id }, {',
             'ad ActivityDetail confirm')
    raw = rb(raw,
             b'        toast({ title: "Akce smaz\xc3\xa1na" });\n        setLocation("/activities");\n      },\n    });\n  };\n\n  const handleStartTimer',
             b'        toast({ title: "Akce smaz\xc3\xa1na" });\n        setLocation("/activities");\n      },\n      });\n    });\n  };\n\n  const handleStartTimer',
             'ad ActivityDetail confirm close')
    # ActivityDetail JSX - ends before MaterialsSection function
    raw = rb(raw,
             b'  );\n}\n\nfunction MaterialsSection({',
             b'  );\n}\n\nfunction MaterialsSection({',
             'ad ActivityDetail JSX check')
    # Find the return end of ActivityDetail
    raw = rb(raw,
             b'      </div>\n    </div>\n  );\n}\n\nfunction MaterialsSection',
             b'      </div>\n    </div>\n    <ConfirmDialog {...dialogPropsActivity} />\n  );\n}\n\nfunction MaterialsSection',
             'ad ActivityDetail JSX')

    # MaterialsSection: add hook
    raw = rb(raw,
             b'function MaterialsSection({\n  activityId,',
             b'function MaterialsSection({\n  activityId,',
             'ad MaterialsSection sig check')
    raw = rb(raw,
             b'  const [showAdd, setShowAdd] = useState(false);\n  const [form, setForm] = useState({ name: "", quantity: "", unit: "", pricePerUnit: "" });\n\n  const total',
             b'  const { openConfirm, dialogProps: dialogPropsMat } = useConfirmDialog();\n  const [showAdd, setShowAdd] = useState(false);\n  const [form, setForm] = useState({ name: "", quantity: "", unit: "", pricePerUnit: "" });\n\n  const total',
             'ad MaterialsSection hook')
    # MaterialsSection: handleDelete confirm (material)
    raw = rb(raw,
             b'    if (!confirm("Smazat materi\xc3\xa1l?")) return;\n    deleteMaterial.mutate({ activityId, materialId: id }, { onSuccess: onChange });',
             b'    openConfirm("Smazat materi\xc3\xa1l?", () => {\n      deleteMaterial.mutate({ activityId, materialId: id }, { onSuccess: onChange });\n    });',
             'ad MaterialsSection confirm')
    raw = rb(raw,
             b'  );\n}\n\nfunction ExtraWorksSection',
             b'  );\n}\n\nfunction ExtraWorksSection',
             'ad MaterialsSection JSX check')
    # Find the Card closing in MaterialsSection
    raw = rb(raw,
             b'    </Card>\n  );\n}\n\nfunction ExtraWorksSection',
             b'    </Card>\n    <ConfirmDialog {...dialogPropsMat} />\n  );\n}\n\nfunction ExtraWorksSection',
             'ad MaterialsSection JSX')

    # ExtraWorksSection: add hook
    raw = rb(raw,
             b'function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const queryClient',
             b'function ExtraWorksSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const { openConfirm, dialogProps: dialogPropsWork } = useConfirmDialog();\n  const queryClient',
             'ad ExtraWorksSection hook')
    # ExtraWorksSection: handleDelete confirm
    raw = rb(raw,
             b'    if (!confirm("Smazat v\xc3\xadcepr\xc3\xa1ci?")) return;\n    deleteWork.mutate({ activityId, extraWorkId: id }, { onSuccess: invalidate });',
             b'    openConfirm("Smazat v\xc3\xadcepr\xc3\xa1ci?", () => {\n      deleteWork.mutate({ activityId, extraWorkId: id }, { onSuccess: invalidate });\n    });',
             'ad ExtraWorksSection confirm')
    raw = rb(raw,
             b'    </Card>\n  );\n}\n\nfunction ActivityTimeEntries',
             b'    </Card>\n    <ConfirmDialog {...dialogPropsWork} />\n  );\n}\n\nfunction ActivityTimeEntries',
             'ad ExtraWorksSection JSX')

    # ActivityDokladySection: add hook
    raw = rb(raw,
             b'function ActivityDokladySection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const queryClient',
             b'function ActivityDokladySection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const { openConfirm, dialogProps: dialogPropsDoklad } = useConfirmDialog();\n  const queryClient',
             'ad ActivityDokladySection hook')
    # handleDelete confirm (doklad)
    raw = rb(raw,
             b'    if (!confirm("Smazat tento doklad?")) return;\n    deleteAttachment.mutate({ activityId, attachmentId: id }, { onSuccess: invalidate });',
             b'    openConfirm("Smazat tento doklad?", () => {\n      deleteAttachment.mutate({ activityId, attachmentId: id }, { onSuccess: invalidate });\n    });',
             'ad ActivityDokladySection confirm')
    raw = rb(raw,
             b'    </Card>\n  );\n}\n\nfunction PhotosSection',
             b'    </Card>\n    <ConfirmDialog {...dialogPropsDoklad} />\n  );\n}\n\nfunction PhotosSection',
             'ad ActivityDokladySection JSX')

    # PhotosSection: add hook
    raw = rb(raw,
             b'function PhotosSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n',
             b'function PhotosSection({ activityId, canWrite }: { activityId: number; canWrite: boolean }) {\n  const { openConfirm, dialogProps: dialogPropsPhoto } = useConfirmDialog();\n',
             'ad PhotosSection hook')
    # PhotosSection: handleDelete confirm (photo)
    raw = rb(raw,
             b'    if (!confirm("Smazat tuto fotografii?")) return;\n    deleteAttachment.mutate({ activityId, attachmentId }, { onSuccess: invalidate });',
             b'    openConfirm("Smazat tuto fotografii?", () => {\n      deleteAttachment.mutate({ activityId, attachmentId }, { onSuccess: invalidate });\n    });',
             'ad PhotosSection confirm')
    # PhotosSection JSX - last function, ends the file
    raw = rb(raw,
             b'    </Card>\n  );\n}\n',
             b'    </Card>\n    <ConfirmDialog {...dialogPropsPhoto} />\n  );\n}\n',
             'ad PhotosSection JSX')

    return raw

proc('artifacts/stavba/src/pages/activity-detail.tsx', fix_activity_detail)

print("\nAll done!")
