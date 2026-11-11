import React from "react";

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 24, color: "#ff8080", whiteSpace: "pre-wrap", font: "12px monospace" }}>
          {String(this.state.error?.stack ?? this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}
