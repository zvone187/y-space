import type { MenuItemConstructorOptions } from "electron";

export function buildApplicationMenuTemplate(
  productName: string,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") return null;

  return [
    {
      label: productName,
      submenu: [
        { label: `About ${productName}`, role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${productName}`, role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Quit ${productName}`, role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
