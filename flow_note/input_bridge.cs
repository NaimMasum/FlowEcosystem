using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace FlowInputBridge
{
    class Program
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll", SetLastError = true)]
        static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("user32.dll", SetLastError = true)]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, [MarshalAs(UnmanagedType.LPArray), In] INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern short VkKeyScan(char ch);

        [StructLayout(LayoutKind.Explicit)]
        struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(4)] public MOUSEINPUT mi;
            [FieldOffset(4)] public KEYBDINPUT ki;
        }

        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;

        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_UNICODE = 0x0004;
        const uint KEYEVENTF_SCANCODE = 0x0008;

        const uint MOUSEEVENTF_MOVE = 0x0001;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint MOUSEEVENTF_WHEEL = 0x0800;
        const uint MOUSEEVENTF_HWHEEL = 0x1000;

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("{\"status\":\"ready\"}");
            Console.Out.Flush();

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;

                try
                {
                    ProcessCommand(line);
                }
                catch (Exception ex)
                {
                    Console.WriteLine("{\"error\":\"" + EscapeJson(ex.Message) + "\"}");
                    Console.Out.Flush();
                }
            }
        }

        static void ProcessCommand(string line)
        {
            string action = GetJsonValue(line, "action");
            if (string.IsNullOrEmpty(action)) return;

            switch (action.ToLowerInvariant())
            {
                case "get_screen":
                {
                    int w = Screen.PrimaryScreen.Bounds.Width;
                    int h = Screen.PrimaryScreen.Bounds.Height;
                    int virtW = SystemInformation.VirtualScreen.Width;
                    int virtH = SystemInformation.VirtualScreen.Height;
                    Console.WriteLine(string.Format("{{\"status\":\"ok\",\"action\":\"get_screen\",\"width\":{0},\"height\":{1},\"virtualWidth\":{2},\"virtualHeight\":{3}}}", w, h, virtW, virtH));
                    Console.Out.Flush();
                    break;
                }

                case "mousemove":
                {
                    int x = GetJsonInt(line, "x", Cursor.Position.X);
                    int y = GetJsonInt(line, "y", Cursor.Position.Y);
                    SetCursorPos(x, y);
                    break;
                }

                case "mousedrag":
                {
                    int dx = GetJsonInt(line, "dx", 0);
                    int dy = GetJsonInt(line, "dy", 0);
                    int curX = Cursor.Position.X + dx;
                    int curY = Cursor.Position.Y + dy;
                    SetCursorPos(curX, curY);
                    break;
                }

                case "mousedown":
                {
                    int x = GetJsonInt(line, "x", -1);
                    int y = GetJsonInt(line, "y", -1);
                    if (x >= 0 && y >= 0) SetCursorPos(x, y);

                    string button = GetJsonValue(line, "button") ?? "left";
                    uint flag = MOUSEEVENTF_LEFTDOWN;
                    if (button == "right") flag = MOUSEEVENTF_RIGHTDOWN;
                    else if (button == "middle") flag = MOUSEEVENTF_MIDDLEDOWN;
                    mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
                    break;
                }

                case "mouseup":
                {
                    int x = GetJsonInt(line, "x", -1);
                    int y = GetJsonInt(line, "y", -1);
                    if (x >= 0 && y >= 0) SetCursorPos(x, y);

                    string button = GetJsonValue(line, "button") ?? "left";
                    uint flag = MOUSEEVENTF_LEFTUP;
                    if (button == "right") flag = MOUSEEVENTF_RIGHTUP;
                    else if (button == "middle") flag = MOUSEEVENTF_MIDDLEUP;
                    mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
                    break;
                }

                case "tap":
                case "click":
                {
                    int x = GetJsonInt(line, "x", -1);
                    int y = GetJsonInt(line, "y", -1);
                    if (x >= 0 && y >= 0) SetCursorPos(x, y);

                    string button = GetJsonValue(line, "button") ?? "left";
                    uint downFlag = MOUSEEVENTF_LEFTDOWN;
                    uint upFlag = MOUSEEVENTF_LEFTUP;
                    if (button == "right") { downFlag = MOUSEEVENTF_RIGHTDOWN; upFlag = MOUSEEVENTF_RIGHTUP; }
                    else if (button == "middle") { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; }

                    mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
                    System.Threading.Thread.Sleep(15);
                    mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
                    break;
                }

                case "dblclick":
                {
                    int x = GetJsonInt(line, "x", -1);
                    int y = GetJsonInt(line, "y", -1);
                    if (x >= 0 && y >= 0) SetCursorPos(x, y);

                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    System.Threading.Thread.Sleep(50);
                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    break;
                }

                case "scroll":
                {
                    int deltaY = GetJsonInt(line, "deltaY", 0);
                    if (deltaY != 0)
                    {
                        int wheelAmount = -deltaY;
                        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)wheelAmount, UIntPtr.Zero);
                    }
                    int deltaX = GetJsonInt(line, "deltaX", 0);
                    if (deltaX != 0)
                    {
                        mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, (uint)deltaX, UIntPtr.Zero);
                    }
                    break;
                }

                case "keydown":
                {
                    byte vk = ResolveVk(GetJsonValue(line, "key"), GetJsonInt(line, "vk", 0));
                    if (vk > 0) keybd_event(vk, 0, 0, UIntPtr.Zero);
                    break;
                }

                case "keyup":
                {
                    byte vk = ResolveVk(GetJsonValue(line, "key"), GetJsonInt(line, "vk", 0));
                    if (vk > 0) keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    break;
                }

                case "type":
                {
                    string text = GetJsonValue(line, "text");
                    if (!string.IsNullOrEmpty(text))
                    {
                        SendUnicodeString(text);
                    }
                    break;
                }

                case "shortcut":
                {
                    string combo = GetJsonValue(line, "combo");
                    if (!string.IsNullOrEmpty(combo))
                    {
                        ExecuteShortcut(combo);
                    }
                    break;
                }
            }
        }

        static void SendUnicodeString(string s)
        {
            if (string.IsNullOrEmpty(s)) return;
            INPUT[] inputs = new INPUT[s.Length * 2];
            for (int i = 0; i < s.Length; i++)
            {
                inputs[i * 2] = new INPUT
                {
                    type = INPUT_KEYBOARD,
                    ki = new KEYBDINPUT
                    {
                        wVk = 0,
                        wScan = (ushort)s[i],
                        dwFlags = KEYEVENTF_UNICODE,
                        time = 0,
                        dwExtraInfo = UIntPtr.Zero
                    }
                };
                inputs[i * 2 + 1] = new INPUT
                {
                    type = INPUT_KEYBOARD,
                    ki = new KEYBDINPUT
                    {
                        wVk = 0,
                        wScan = (ushort)s[i],
                        dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time = 0,
                        dwExtraInfo = UIntPtr.Zero
                    }
                };
            }
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void ExecuteShortcut(string combo)
        {
            string[] parts = combo.ToLowerInvariant().Split('+');
            byte[] vks = new byte[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                vks[i] = ResolveVk(parts[i].Trim(), 0);
            }

            for (int i = 0; i < vks.Length; i++)
            {
                if (vks[i] > 0) keybd_event(vks[i], 0, 0, UIntPtr.Zero);
            }

            System.Threading.Thread.Sleep(20);

            for (int i = vks.Length - 1; i >= 0; i--)
            {
                if (vks[i] > 0) keybd_event(vks[i], 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
        }

        static byte ResolveVk(string key, int fallbackVk)
        {
            if (fallbackVk > 0) return (byte)fallbackVk;
            if (string.IsNullOrEmpty(key)) return 0;

            switch (key.ToLowerInvariant())
            {
                case "enter": case "return": return 0x0D;
                case "escape": case "esc": return 0x1B;
                case "backspace": return 0x08;
                case "tab": return 0x09;
                case "space": return 0x20;
                case "delete": case "del": return 0x2E;
                case "insert": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "arrowup": case "up": return 0x26;
                case "arrowdown": case "down": return 0x28;
                case "arrowleft": case "left": return 0x25;
                case "arrowright": case "right": return 0x27;
                case "control": case "ctrl": return 0x11;
                case "shift": return 0x10;
                case "alt": return 0x12;
                case "win": case "meta": case "super": return 0x5B;
                case "f1": return 0x70;
                case "f2": return 0x71;
                case "f3": return 0x72;
                case "f4": return 0x73;
                case "f5": return 0x74;
                case "f6": return 0x75;
                case "f7": return 0x76;
                case "f8": return 0x77;
                case "f9": return 0x78;
                case "f10": return 0x79;
                case "f11": return 0x7A;
                case "f12": return 0x7B;
                default:
                    if (key.Length == 1)
                    {
                        short scan = VkKeyScan(key[0]);
                        return (byte)(scan & 0xFF);
                    }
                    return 0;
            }
        }

        static string GetJsonValue(string json, string key)
        {
            string pattern = "\"" + key + "\":\"";
            int idx = json.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                int start = idx + pattern.Length;
                int end = json.IndexOf("\"", start);
                if (end > start)
                {
                    return json.Substring(start, end - start).Replace("\\\"", "\"").Replace("\\\\", "\\");
                }
            }

            string patternUnquoted = "\"" + key + "\":";
            int uIdx = json.IndexOf(patternUnquoted, StringComparison.OrdinalIgnoreCase);
            if (uIdx >= 0)
            {
                int start = uIdx + patternUnquoted.Length;
                int end = json.IndexOfAny(new char[] { ',', '}', ']' }, start);
                if (end < 0) end = json.Length;
                return json.Substring(start, end - start).Trim().Trim('"');
            }

            return null;
        }

        static int GetJsonInt(string json, string key, int fallback)
        {
            string val = GetJsonValue(json, key);
            if (val == null) return fallback;
            int res;
            if (int.TryParse(val, out res)) return res;
            double dRes;
            if (double.TryParse(val, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out dRes))
            {
                return (int)Math.Round(dRes);
            }
            return fallback;
        }

        static string EscapeJson(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        }
    }
}
