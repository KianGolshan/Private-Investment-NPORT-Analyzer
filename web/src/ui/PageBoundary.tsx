import { Component, type ComponentChildren } from 'preact';

// A page that throws shows a way out instead of a blank page (review 2026-10-15 N5).
// preact-iso's ErrorBoundary only handles lazy loading; this one catches real
// errors and clears itself when the visitor moves to another page.
export class PageBoundary extends Component<
  { path: string; children: ComponentChildren },
  { failedAt: string | null }
> {
  override state = { failedAt: null as string | null };
  override componentDidCatch(err: unknown) {
    console.error(err);
    this.setState({ failedAt: this.props.path });
  }
  override render() {
    if (this.state.failedAt !== null && this.state.failedAt === this.props.path)
      return (
        <div class="empty" role="alert">
          <h1>This page hit a problem</h1>
          <p>
            Something went wrong while showing it. Reload to try again, or go to the <a href="/">market overview</a>.
          </p>
          <button class="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    return this.props.children;
  }
}
