import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Settings() {
  const { theme, setTheme } = useTheme();

  const themes = [
    { value: "light", label: "Světlý", icon: Sun },
    { value: "dark", label: "Tmavý", icon: Moon },
    { value: "system", label: "Systémový", icon: Monitor },
  ];

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Nastavení</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sun className="h-5 w-5" /> Vzhled aplikace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
        </CardContent>
      </Card>
    </div>
  );
}
