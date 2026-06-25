import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

const TEST_MODE_DURATION = 30_000
const isTestMode =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("testMode") === "1"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider duration={isTestMode ? TEST_MODE_DURATION : undefined}>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
