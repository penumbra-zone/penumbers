import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

export default function Index() {
  return (
    <div className="flex h-screen items-center justify-center">
      <p>Test?</p>
    </div>
  );
}
