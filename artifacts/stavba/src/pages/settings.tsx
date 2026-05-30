import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor, Building2, Upload, X, Palette, PenLine } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  loadCompanySettings,
  saveCompanySettings,
  applyTextColor,
  type CompanySettings,
} from "@/lib/company-settings";

const MAX_LOGO_BYTES = 500 * 1024;
const MAX_SIGNATURE_BYTES = 500 * 1024;

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [companyName, setCompanyName] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [info, setInfo] = useState("");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [textColor, setTextColor] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sigRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = loadCompanySettings();
    setCompanyName(s.name);
    setLogoDataUrl(s.logoDataUrl);
    setInfo(s.info);
    setSignatureDataUrl(s.signatureDataUrl);
    setTextColor(s.textColor);
  }, []);

  function persist(next: Partial<CompanySettings>) {
    const merged: CompanySettings = {
      name: next.name ?? companyName,
      logoDataUrl: next.logoDataUrl ?? logoDataUrl,
      info: next.info ?? info,
      signatureDataUrl: next.signatureDataUrl ?? signatureDataUrl,
      textColor: next.textColor ?? textColor,
    };
    saveCompanySettings(merged);
    setSavedAt(Date.now());
  }

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    if (!/^image\/(png|jpeg|jpg)$/i.test(file.type)) {
      setLogoError("Použijte obrázek PNG nebo JPG.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo je větší než 500 kB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setLogoDataUrl(url);
      persist({ logoDataUrl: url });
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onSignatureFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSignatureError(null);
    if (!/^image\/(png|jpeg|jpg)$/i.test(file.type)) {
      setSignatureError("Použijte obrázek PNG nebo JPG.");
      return;
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      setSignatureError("Podpis je větší než 500 kB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setSignatureDataUrl(url);
      persist({ signatureDataUrl: url });
    };
    reader.readAsDataURL(file);
    if (sigRef.current) sigRef.current.value = "";
  }

  function clearLogo() {
    setLogoDataUrl("");
    persist({ logoDataUrl: "" });
  }

  function clearSignature() {
    setSignatureDataUrl("");
    persist({ signatureDataUrl: "" });
  }

  function onTextColorChange(value: string) {
    setTextColor(value);
    applyTextColor(value);
    persist({ textColor: value });
  }

  function resetTextColor() {
    setTextColor("");
    applyTextColor("");
    persist({ textColor: "" });
  }

  const themes = [
    { value: "light", label: "Světlý", icon: Sun },
    { value: "dark", label: "Tmavý", icon: Moon },
    { value: "system", label: "Systémový", icon: Monitor },
  ];

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto w-full space-y-6">
      <h1 className="text-2xl font-bold">Nastavení</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sun className="h-5 w-5" /> Vzhled aplikace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Vyberte barevný režim zobrazení.</p>
            <div className="grid grid-cols-3 gap-3">
              {themes.map(({ value, label, icon: Icon }) => {
                const isActive = theme === value;
                return (
                  <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                      isActive
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-7 w-7" />
                    <span className="text-sm font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2">
              <Palette className="h-4 w-4" /> Barva textu
            </Label>
            <p className="text-sm text-muted-foreground">
              Vlastní barva hlavního textu aplikace. Ponechte výchozí pro standardní vzhled.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={textColor || "#0f172a"}
                onChange={(e) => onTextColorChange(e.target.value)}
                className="h-10 w-14 rounded-md border bg-card cursor-pointer p-1"
                aria-label="Barva textu"
              />
              <Input
                value={textColor}
                onChange={(e) => onTextColorChange(e.target.value)}
                placeholder="#0f172a"
                className="max-w-[160px] font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetTextColor}
                className="text-muted-foreground"
              >
                Výchozí
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-5 w-5" /> Firma a dokumenty
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Název, logo, informace o firmě a podpis se použijí na vytištěných a
            zasílaných dokumentech (zakázkový list, exporty).
          </p>

          <div className="space-y-2">
            <Label htmlFor="company-name">Název firmy</Label>
            <Input
              id="company-name"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onBlur={() => persist({ name: companyName })}
              placeholder="Např. Stavby Novák s.r.o."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="company-info">Informace o firmě</Label>
            <Textarea
              id="company-info"
              value={info}
              onChange={(e) => setInfo(e.target.value)}
              onBlur={() => persist({ info })}
              rows={4}
              placeholder={"IČO, DIČ, adresa, telefon, e-mail, číslo účtu…"}
            />
            <p className="text-xs text-muted-foreground">
              Zobrazí se na dokumentech pod názvem firmy.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {logoDataUrl ? (
                <div className="h-16 w-24 border rounded-md bg-muted/30 flex items-center justify-center overflow-hidden">
                  <img
                    src={logoDataUrl}
                    alt="Logo firmy"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-16 w-24 border border-dashed rounded-md flex items-center justify-center text-xs text-muted-foreground">
                  Bez loga
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {logoDataUrl ? "Změnit logo" : "Nahrát logo"}
                </Button>
                {logoDataUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearLogo}
                    className="gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                    Odebrat
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={onLogoFile}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              PNG nebo JPG, max 500 kB. Doporučeno: průhledné PNG.
            </p>
            {logoError && <p className="text-xs text-destructive">{logoError}</p>}
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2">
              <PenLine className="h-4 w-4" /> Podpis na dokumenty
            </Label>
            <div className="flex items-center gap-3">
              {signatureDataUrl ? (
                <div className="h-20 w-40 border rounded-md bg-white flex items-center justify-center overflow-hidden">
                  <img
                    src={signatureDataUrl}
                    alt="Podpis"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-20 w-40 border border-dashed rounded-md flex items-center justify-center text-xs text-muted-foreground text-center px-2">
                  Bez podpisu
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => sigRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {signatureDataUrl ? "Změnit podpis" : "Nahrát podpis"}
                </Button>
                {signatureDataUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearSignature}
                    className="gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                    Odebrat
                  </Button>
                )}
              </div>
              <input
                ref={sigRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={onSignatureFile}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              PNG nebo JPG, max 500 kB. Použije se jako podpis zhotovitele na zakázkovém listu.
            </p>
            {signatureError && (
              <p className="text-xs text-destructive">{signatureError}</p>
            )}
          </div>

          {savedAt && <p className="text-xs text-muted-foreground">Uloženo.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
