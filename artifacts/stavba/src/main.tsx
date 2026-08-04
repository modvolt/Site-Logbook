import { createRoot } from "react-dom/client";
import App from "./App";
import { installIdentityFetchGuard } from "@/lib/identity-fetch";
import "./index.css";

installIdentityFetchGuard();
createRoot(document.getElementById("root")!).render(<App />);
