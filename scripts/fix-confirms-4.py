"""
Fix 1: Corrupted imports in billing-document-detail.tsx and customer-detail.tsx
Fix 2: ConfirmDialog siblings — move inside parent element via regex
"""
import re

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

IMPORT_LINES = (
    b'import { ConfirmDialog } from "@/components/confirm-dialog";\n'
    b'import { useConfirmDialog } from "@/hooks/use-confirm-dialog";\n'
)

# ─────────────────────────────────────────────
# Fix corrupted imports
# billing-document-detail.tsx: `import { useLocation\nimport {...};, useRoute } from "wouter";`
# ─────────────────────────────────────────────
def fix_billing_import(raw):
    # The corrupted block:
    # `import { useLocation\nimport { ConfirmDialog } ...;\nimport { useConfirmDialog } ...;, useRoute } from "wouter";`
    raw = rb(raw,
        b'import { useLocation\n' + IMPORT_LINES + b', useRoute } from "wouter";',
        IMPORT_LINES + b'import { useLocation, useRoute } from "wouter";',
        'billing import fix')
    return raw

proc('artifacts/stavba/src/pages/billing-document-detail.tsx', fix_billing_import)

# customer-detail.tsx: `import { useParams\nimport {...};, useLocation } from "wouter";`
def fix_cdetail_import(raw):
    raw = rb(raw,
        b'import { useParams\n' + IMPORT_LINES + b', useLocation } from "wouter";',
        IMPORT_LINES + b'import { useParams, useLocation } from "wouter";',
        'cdetail import fix')
    return raw

proc('artifacts/stavba/src/pages/customer-detail.tsx', fix_cdetail_import)

# ─────────────────────────────────────────────
# Fix JSX sibling errors: move <ConfirmDialog> inside its parent element
# Pattern: `\n    </TAG>\n    <ConfirmDialog {...X} />\n  );\n}`
# Fix:     `\n      <ConfirmDialog {...X} />\n    </TAG>\n  );\n}`
# Also handle `</Card>` and `</SectionCard>` variants
# ─────────────────────────────────────────────
import re

def fix_jsx_siblings(raw):
    # Match any closing tag at 4-space indent followed by a ConfirmDialog at 4-space indent
    pattern = re.compile(
        rb'(\n    </(?:div|Card|SectionCard|CardContent)>)(\n    <ConfirmDialog \{\.\.\.[\w]+\} />)(\n  \);\n\})',
    )
    def replacer(m):
        tag = m.group(1)    # e.g. `\n    </div>`
        dialog = m.group(2) # e.g. `\n    <ConfirmDialog {...dialogProps} />`
        end = m.group(3)    # `\n  );\n}`
        # Move dialog inside the tag: dialog at 6-space indent, then tag
        dialog_inner = dialog.replace(b'\n    <', b'\n      <')
        return dialog_inner + tag + end
    return pattern.sub(replacer, raw)

# Apply to all stavba page/component files
import os
import glob

for filepath in glob.glob('artifacts/stavba/src/**/*.tsx', recursive=True):
    with open(filepath, 'rb') as f:
        raw = f.read()
    fixed = fix_jsx_siblings(raw)
    if fixed != raw:
        with open(filepath, 'wb') as f:
            f.write(fixed)
        print(f"JSX fixed: {filepath}")

print("\nAll done!")
