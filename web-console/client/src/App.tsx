/** 取证工作台设计：将页面作为连续的“提交—研判—训练”案卷流，而非传统居中式仪表盘。 */

import { Toaster } from "@/components/ui/sonner";
import ErrorBoundary from "./components/ErrorBoundary";
import Home from "./pages/Home";

function App() {
  return (
    <ErrorBoundary>
      <Home />
      <Toaster richColors position="top-right" />
    </ErrorBoundary>
  );
}

export default App;
