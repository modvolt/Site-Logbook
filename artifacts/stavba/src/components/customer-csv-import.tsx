import { useRef, useState } from "react";
import Papa from "papaparse";
import { useImportCustomers } from "@workspace/api-client-react";
import type { CustomerImportItem } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Upload, Download, FileSpreadsheet } from "lucide-react";
import { FileDropZone } from "@/components/file-drop-zone";
import { useToast } from "@/hooks/use-toast";

type FieldKey =
  | "companyName"
  | "contactPerson"
  | "phone"
  | "email"
  | "ic"
  | "dic"
  | "address";

type FieldDef = { key: FieldKey; label: string; required?: boolean };

const FIELDS: FieldDef[] = [
  { key: "companyName", label: "Název firmy", required: true },
  { key: "contactPerson", label: "Kontaktní osoba" },
  { key: "phone", label: "Telefon" },
  { key: "email", label: "E-mail" },
  { key: "ic", label: "IČ" },
  { key: "dic", label: "DIČ" },
  { key: "address", label: "Adresa" },
];

const IGNORE = "__ignore__";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

// Heuristics to auto-map a source header to one of our fields.
const GUESS: Record<FieldKey, string[]> = {
  companyName: ["nazevfirmy", "nazev", "firma", "spolecnost", "company", "companyname", "zakaznik", "klient", "name"],
  contactPerson: ["kontaktniosoba", "kontakt", "osoba", "contact", "contactperson", "jmeno"],
  phone: ["telefon", "tel", "phone", "mobil"],
  email: ["email", "mail", "mejl"],
  ic: ["ic", "ico", "icdph"],
  dic: ["dic", "dico", "vat", "taxid"],
  address: ["adresa", "address", "sidlo", "ulice", "mesto"],
};

function autoMap(headers: string[]): Record<FieldKey, string> {
  const map = {} as Record<FieldKey, string>;
  for (const f of FIELDS) {
    const hit = headers.find((h) => GUESS[f.key].some((g) => norm(h) === g));
    const partial =
      hit ?? headers.find((h) => GUESS[f.key].some((g) => norm(h).includes(g)));
    map[f.key] = partial ?? IGNORE;
  }
  return map;
}

const TEMPLATE_HEADERS = FIELDS.map((f) => f.label);
const TEMPLATE_EXAMPLE = [
  "Novák Stavby s.r.o.",
  "Jan Novák",
  "777123456",
  "info@novakstavby.cz",
  "12345678",
  "CZ12345678",
  "Korunní 47, Praha 2",
];

function downloadTemplate() {
  const csv =
    TEMPLATE_HEADERS.join(";") + "\n" + TEMPLATE_EXAMPLE.join(";") + "\n";
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sablona-zakaznici.csv";
  a.click();
  URL.revokeObjectURL(url);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
};

export default function CustomerCsvImport({ open, onOpenChange, onImported }: Props) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const importCustomers = useImportCustomers();

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<FieldKey, string>>(
    {} as Record<FieldKey, string>,
  );

  const reset = () => {
    setFileName("");
    setHeaders([]);
    setRows([]);
    setMapping({} as Record<FieldKey, string>);
    if (fileInput.current) fileInput.current.value = "";
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = (file: File) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const hdrs = (res.meta.fields ?? []).filter((h) => h.length > 0);
        if (hdrs.length === 0) {
          toast({ title: "CSV neobsahuje hlavičku sloupců", variant: "destructive" });
          return;
        }
        setFileName(file.name);
        setHeaders(hdrs);
        setRows(res.data);
        setMapping(autoMap(hdrs));
      },
      error: () =>
        toast({ title: "Soubor se nepodařilo načíst", variant: "destructive" }),
    });
  };

  const buildItems = (): CustomerImportItem[] => {
    const out: CustomerImportItem[] = [];
    for (const row of rows) {
      const nameCol = mapping.companyName;
      const companyName =
        nameCol && nameCol !== IGNORE ? String(row[nameCol] ?? "").trim() : "";
      const item: CustomerImportItem = { companyName };
      const bag = item as unknown as Record<string, unknown>;
      for (const f of FIELDS) {
        if (f.key === "companyName") continue;
        const col = mapping[f.key];
        if (!col || col === IGNORE) continue;
        const value = String(row[col] ?? "").trim();
        if (value === "") continue;
        bag[f.key] = value;
      }
      out.push(item);
    }
    return out;
  };

  const allItems = rows.length > 0 ? buildItems() : [];
  const validItems = allItems.filter((it) => it.companyName.trim() !== "");
  const validCount = validItems.length;
  const skipCount = allItems.length - validCount;

  const handleImport = () => {
    const items = buildItems();
    if (validCount === 0) {
      toast({ title: "Žádní platní zákazníci k importu", variant: "destructive" });
      return;
    }
    importCustomers.mutate(
      { data: { items } },
      {
        onSuccess: (res) => {
          toast({
            title: "Import dokončen",
            description: `Založeno: ${res.created} · Aktualizováno: ${res.updated} · Přeskočeno: ${res.skipped}`,
          });
          reset();
          onOpenChange(false);
          onImported();
        },
        onError: () =>
          toast({ title: "Import se nezdařil", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import zákazníků (CSV)</DialogTitle>
          <DialogDescription>
            Nahrajte CSV soubor, namapujte sloupce na naše pole a spusťte import.
            Existující zákazníci se spárují podle IČ (nebo názvu firmy) a
            aktualizují, noví se založí.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <Button variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload className="h-4 w-4 mr-2" />
              {fileName ? "Vybrat jiný soubor" : "Vybrat CSV"}
            </Button>
            <Button variant="ghost" onClick={downloadTemplate}>
              <Download className="h-4 w-4 mr-2" /> Stáhnout vzorovou šablonu
            </Button>
            {fileName && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" /> {fileName} · {rows.length} řádků
              </span>
            )}
          </div>

          <FileDropZone
            onFiles={(files) => files[0] && handleFile(files[0])}
            accept=".csv,text/csv"
            multiple={false}
            label="Sem přetáhněte CSV soubor"
          />

          {headers.length > 0 && (
            <>
              <div>
                <h3 className="font-medium mb-2">Mapování sloupců</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="space-y-1">
                      <label className="text-sm font-medium">
                        {f.label}
                        {f.required && <span className="text-destructive"> *</span>}
                      </label>
                      <Select
                        value={mapping[f.key] ?? IGNORE}
                        onValueChange={(v) =>
                          setMapping((m) => ({ ...m, [f.key]: v }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="— ignorovat —" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={IGNORE}>— ignorovat —</SelectItem>
                          {headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-medium mb-2">
                  Náhled ({validCount} platných zákazníků
                  {skipCount > 0 ? `, ${skipCount} bez názvu se přeskočí` : ""})
                </h3>
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {FIELDS.map((f) => (
                          <TableHead key={f.key}>{f.label}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {validItems.slice(0, 8).map((it, i) => (
                        <TableRow key={i}>
                          {FIELDS.map((f) => {
                            const v = (it as unknown as Record<string, unknown>)[f.key];
                            return (
                              <TableCell key={f.key} className="whitespace-nowrap">
                                {v == null || v === "" ? "—" : String(v)}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {validCount > 8 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Zobrazeno prvních 8 z {validCount} zákazníků.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Zrušit
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              validCount === 0 ||
              mapping.companyName === IGNORE ||
              !mapping.companyName ||
              importCustomers.isPending
            }
          >
            {importCustomers.isPending
              ? "Importuji…"
              : `Importovat ${validCount} zákazníků`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
