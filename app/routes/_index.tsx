import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { db } from "backend/database";

export const loader = async () => {
  return await db
    .selectFrom("supply_total_unstaked")
    .orderBy("height", "desc")
    .selectAll()
    .limit(1)
    .executeTakeFirstOrThrow();
};

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  return (
    <div className="flex h-screen items-center justify-center">
      <p>{`${data.height + 2n}`}</p>
      <p>{JSON.stringify(data)}</p>
    </div>
  );
}
