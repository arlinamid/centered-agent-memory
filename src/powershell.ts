/**
 * Spawn argv for powershell.exe that does not flash a console window.
 *
 * `windowsHide` maps to CREATE_NO_WINDOW, which is not enough on its own:
 * powershell still allocates a console briefly unless `-WindowStyle Hidden`
 * is on the command line. Every caller that lists processes or registers a
 * scheduled task goes through here, so a missed flag cannot reintroduce the
 * hourly flash.
 */
export function powershellArgv(...rest: string[]): string[] {
  return ["-NoProfile", "-WindowStyle", "Hidden", "-NonInteractive", ...rest];
}
