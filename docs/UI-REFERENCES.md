# Desktop design references

The user authorized inspection of an installed JetBrains IDE to inform Cortex's
settings and workbench design. These are local design references, not Cortex
acceptance results or permission to copy proprietary assets.

## PyCharm Settings, 2026-10-11

Inspected PyCharm 2025.2.5, build 252.28238.29, in an owned D: configuration,
system, plugins, log and temporary directory. No project import, account login,
license selection or startup/privacy/settings choice was made. Directory
redirection is not a security sandbox or proof of network silence. A startup
prompt disappeared between observations; its cause is unknown.

Ctrl+Alt+S opened Settings. The application-buffer capture shows:

- Search above the left category tree, with a clear selected category.
- Breadcrumbs and aligned fields in the main area.
- Group separators and accessibility options within Appearance.
- A scope hint and conventional OK, Cancel and disabled Apply controls.

Keep this hierarchy and density in mind for a separately planned Cortex Settings
change. No broad Settings redesign or new save/apply policy is implemented here.
The current compact Cortex workbench and embedded-tool feel remain intentional.

Local reference root:
`D:/cortex-jetbrains-reference/pycharm-202525-20261011-1757/`.
Settings image `settings-buffer-fc229f33686b4f95a2da4e1c13559a67.png`, 1494x1008,
SHA256 `3B10B6B87D0601951F64852FF06F7DBF51C1B2946AC46DA770BF4E3509415C22`.
Root inspected the actual image. PrintWindow captures an application buffer;
it does not prove foreground visibility or consent to a prompt. See Microsoft's
[PrintWindow documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow).

The owned modal and welcome window closed naturally; the close receipt records
normal exit and no forced termination. An independent later census found the
original PID 22180 and sampled children 27048/8108 absent. Complete fast-child
coverage is not claimed. Screenshots remain local, not bundled or published.
