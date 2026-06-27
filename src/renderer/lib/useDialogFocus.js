import { useEffect } from "react";

export function useDialogFocus(open, dialogRef) {
  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    if (!node) return undefined;

    const previousActive = document.activeElement;
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      Array.from(node.querySelectorAll(focusableSelector)).filter((el) => el.offsetParent !== null);

    const firstField = node.querySelector(
      'input:not([type]):not([disabled]), input[type="text"]:not([disabled]), textarea:not([disabled])'
    );
    (firstField || getFocusable()[0] || node).focus();

    function onTrapKeyDown(event) {
      if (event.key !== "Tab") return;
      const items = getFocusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    node.addEventListener("keydown", onTrapKeyDown);
    return () => {
      node.removeEventListener("keydown", onTrapKeyDown);
      if (previousActive && typeof previousActive.focus === "function") previousActive.focus();
    };
  }, [open, dialogRef]);
}
