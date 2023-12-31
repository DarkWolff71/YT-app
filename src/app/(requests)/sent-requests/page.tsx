import { JoinRoomSentRequest, PageContent } from "@/components/ui";
import { getCookiesString } from "@/lib/helpers/cookiesString";
import { GetSentRequestsResponse } from "@/types/response";
import React from "react";

async function fetchData(url: string) {
  const response = await fetch(url, {
    next: { revalidate: 0 },
    headers: {
      Cookie: getCookiesString(),
    },
  });
  return response.json();
}

export default async function SentRequests() {
  let { requests: sentRequests }: GetSentRequestsResponse = await fetchData(
    "http://localhost:3000/api/get-sent-requests"
  );

  return (
    <PageContent title="Sent Requests">
      <div className="space-y-4">
        {sentRequests.map((request) => {
          let props = {
            requestId: request.id,
            toUser: request.toUser,
            displayEditors: request.displayEditors,
            displayOwners: request.displayOwners,
            role: request.role,
          };
          return (
            <JoinRoomSentRequest
              key={request.id}
              {...props}
            ></JoinRoomSentRequest>
          );
        })}
      </div>
    </PageContent>
  );
}
