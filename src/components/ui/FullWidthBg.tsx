import React from "react";

type Props = {
  children?: React.ReactNode;
  className?: string;
};

export function FullWidthBg({ children, className }: Props) {
  return (
    <>
      <div
        className={
          " rounded bg-gray-50 dark:bg-gray-800 p-1 min-h-fit" + " " + className
        }
      >
        {children}
      </div>
    </>
  );
}