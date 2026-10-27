// Chess core for ChessPuzzles.ps1: move generation, the move narrator, Glicko-2
// ratings, the puzzle store, the Stockfish client and its installer.
// Windows PowerShell 5.1 compiles this with the old C# 5 compiler: no string
// interpolation, no ?., no expression-bodied members, no out var, no nameof.
// Kept ASCII-only. Squares are 0..63 with a1 = 0, h1 = 7, a8 = 56, h8 = 63.
// Pieces are signed: +1..+6 white pawn, knight, bishop, rook, queen, king; negative black.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace ChessCore
{
    // --- Windows calls the window needs, plus the job object that ties Stockfish to it.
    public static class ChessWin32
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static IntPtr WindowByText(string text)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                var title = new StringBuilder(256);
                GetWindowText(hWnd, title, title.Capacity);
                if (title.ToString() == text) { found = hWnd; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        static IntPtr killJob = IntPtr.Zero;

        // Puts a process in a job that Windows kills when this process exits, however it exits.
        public static bool TieToThisProcess(Process child)
        {
            try
            {
                if (killJob == IntPtr.Zero)
                {
                    var job = CreateJobObject(IntPtr.Zero, null);
                    if (job == IntPtr.Zero) return false;
                    var limits = new ExtendedLimits();
                    limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int length = Marshal.SizeOf(typeof(ExtendedLimits));
                    IntPtr buffer = Marshal.AllocHGlobal(length);
                    try
                    {
                        Marshal.StructureToPtr(limits, buffer, false);
                        if (!SetInformationJobObject(job, 9, buffer, (uint)length)) return false;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                    killJob = job;
                }
                return AssignProcessToJobObject(killJob, child.Handle);
            }
            catch { return false; }
        }
    }

    public sealed class ChessMove
    {
        public int From, To;
        public int Piece;      // 1..6, the colour comes from the board
        public int Captured;   // 0 or 1..6
        public int Promo;      // 0 or 2..5
        public int Flags;      // CASTLE, EN_PASSANT, DOUBLE_PUSH
        public const int CASTLE = 1, EN_PASSANT = 2, DOUBLE_PUSH = 4;

        public bool IsCastle { get { return (Flags & CASTLE) != 0; } }
        public bool IsEnPassant { get { return (Flags & EN_PASSANT) != 0; } }
        public bool IsCapture { get { return Captured != 0; } }

        public string Uci()
        {
            string text = Board.SquareName(From) + Board.SquareName(To);
            if (Promo != 0) text += "pnbrqk"[Promo - 1];
            return text;
        }
        public override string ToString() { return Uci(); }
    }

    public sealed class Board
    {
        public const int PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
        public sbyte[] Squares = new sbyte[64];
        public bool WhiteToMove = true;
        public int Castling;        // 1 white short, 2 white long, 4 black short, 8 black long
        public int EpSquare = -1;   // the square a pawn passed over, or -1
        public int HalfMove, FullMove = 1;

        static readonly int[][] KNIGHT_STEPS = { new[] { 1, 2 }, new[] { 2, 1 }, new[] { 2, -1 }, new[] { 1, -2 }, new[] { -1, -2 }, new[] { -2, -1 }, new[] { -2, 1 }, new[] { -1, 2 } };
        static readonly int[][] KING_STEPS = { new[] { 1, 0 }, new[] { 1, 1 }, new[] { 0, 1 }, new[] { -1, 1 }, new[] { -1, 0 }, new[] { -1, -1 }, new[] { 0, -1 }, new[] { 1, -1 } };
        public static readonly int[][] DIAGONALS = { new[] { 1, 1 }, new[] { -1, 1 }, new[] { 1, -1 }, new[] { -1, -1 } };
        public static readonly int[][] LINES = { new[] { 1, 0 }, new[] { -1, 0 }, new[] { 0, 1 }, new[] { 0, -1 } };

        public static int FileOf(int sq) { return sq & 7; }
        public static int RankOf(int sq) { return sq >> 3; }
        public static bool OnBoard(int file, int rank) { return file >= 0 && file < 8 && rank >= 0 && rank < 8; }
        public static string SquareName(int sq) { return "" + (char)('a' + FileOf(sq)) + (char)('1' + RankOf(sq)); }
        public static int SquareIndex(string name)
        {
            if (name == null || name.Length != 2) return -1;
            int file = name[0] - 'a', rank = name[1] - '1';
            return OnBoard(file, rank) ? rank * 8 + file : -1;
        }
        public static int PieceValue(int piece)
        {
            switch (Math.Abs(piece)) { case 1: return 1; case 2: return 3; case 3: return 3; case 4: return 5; case 5: return 9; default: return 0; }
        }
        public static string PieceLetter(int piece) { return "PNBRQK".Substring(Math.Abs(piece) - 1, 1); }

        public int PieceAt(int sq) { return Squares[sq]; }
        public bool IsWhite(int sq) { return Squares[sq] > 0; }

        // --- FEN ------------------------------------------------------------------
        public static Board FromFen(string fen)
        {
            var parts = fen.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 4) throw new FormatException("FEN needs at least 4 fields");
            var board = new Board();
            var ranks = parts[0].Split('/');
            if (ranks.Length != 8) throw new FormatException("FEN needs 8 ranks");
            for (int r = 0; r < 8; r++)
            {
                int file = 0, rank = 7 - r;
                foreach (char c in ranks[r])
                {
                    if (c >= '1' && c <= '8') { file += c - '0'; continue; }
                    int index = "pnbrqk".IndexOf(char.ToLowerInvariant(c));
                    if (index < 0 || file > 7) throw new FormatException("bad FEN piece " + c);
                    board.Squares[rank * 8 + file] = (sbyte)(char.IsUpper(c) ? index + 1 : -(index + 1));
                    file++;
                }
                if (file != 8) throw new FormatException("FEN rank " + (rank + 1) + " is not 8 squares");
            }
            if (parts[1] != "w" && parts[1] != "b") throw new FormatException("bad side to move");
            board.WhiteToMove = parts[1] == "w";
            if (parts[2] != "-")
                foreach (char c in parts[2])
                {
                    int bit = "KQkq".IndexOf(c);
                    if (bit < 0) throw new FormatException("bad castling field");
                    board.Castling |= 1 << bit;
                }
            board.EpSquare = parts[3] == "-" ? -1 : SquareIndex(parts[3]);
            if (parts.Length > 4) int.TryParse(parts[4], out board.HalfMove);
            if (parts.Length > 5) int.TryParse(parts[5], out board.FullMove);
            if (board.KingSquare(true) < 0 || board.KingSquare(false) < 0) throw new FormatException("a king is missing");
            return board;
        }

        public string ToFen()
        {
            var text = new StringBuilder();
            for (int rank = 7; rank >= 0; rank--)
            {
                int empty = 0;
                for (int file = 0; file < 8; file++)
                {
                    int p = Squares[rank * 8 + file];
                    if (p == 0) { empty++; continue; }
                    if (empty > 0) { text.Append(empty); empty = 0; }
                    char letter = "pnbrqk"[Math.Abs(p) - 1];
                    text.Append(p > 0 ? char.ToUpperInvariant(letter) : letter);
                }
                if (empty > 0) text.Append(empty);
                if (rank > 0) text.Append('/');
            }
            text.Append(WhiteToMove ? " w " : " b ");
            string rights = "";
            for (int bit = 0; bit < 4; bit++) if ((Castling & (1 << bit)) != 0) rights += "KQkq"[bit];
            text.Append(rights.Length > 0 ? rights : "-");
            text.Append(' ').Append(EpSquare < 0 ? "-" : SquareName(EpSquare));
            text.Append(' ').Append(HalfMove).Append(' ').Append(FullMove);
            return text.ToString();
        }

        public Board Clone()
        {
            var copy = (Board)MemberwiseClone();
            copy.Squares = (sbyte[])Squares.Clone();
            return copy;
        }

        public int KingSquare(bool white)
        {
            sbyte king = (sbyte)(white ? KING : -KING);
            for (int sq = 0; sq < 64; sq++) if (Squares[sq] == king) return sq;
            return -1;
        }

        // --- Attacks ---------------------------------------------------------------
        // Squares of the pieces of one side that attack a square. A slider's ray
        // stops at the first piece, so this is also "who defends the piece there".
        public int[] Attackers(int sq, bool byWhite)
        {
            var found = new List<int>();
            int file = FileOf(sq), rank = RankOf(sq);
            int sign = byWhite ? 1 : -1;
            int pawnRank = rank - sign;
            foreach (int df in new[] { -1, 1 })
                if (OnBoard(file + df, pawnRank) && Squares[pawnRank * 8 + file + df] == sign * PAWN) found.Add(pawnRank * 8 + file + df);
            foreach (var step in KNIGHT_STEPS)
            {
                int f = file + step[0], r = rank + step[1];
                if (OnBoard(f, r) && Squares[r * 8 + f] == sign * KNIGHT) found.Add(r * 8 + f);
            }
            foreach (var step in KING_STEPS)
            {
                int f = file + step[0], r = rank + step[1];
                if (OnBoard(f, r) && Squares[r * 8 + f] == sign * KING) found.Add(r * 8 + f);
            }
            AddSliders(found, sq, DIAGONALS, sign * BISHOP, sign * QUEEN);
            AddSliders(found, sq, LINES, sign * ROOK, sign * QUEEN);
            return found.ToArray();
        }

        void AddSliders(List<int> found, int sq, int[][] directions, int slider, int queen)
        {
            foreach (var d in directions)
            {
                int f = FileOf(sq) + d[0], r = RankOf(sq) + d[1];
                while (OnBoard(f, r))
                {
                    int p = Squares[r * 8 + f];
                    if (p != 0) { if (p == slider || p == queen) found.Add(r * 8 + f); break; }
                    f += d[0]; r += d[1];
                }
            }
        }

        public bool IsAttacked(int sq, bool byWhite) { return Attackers(sq, byWhite).Length > 0; }

        // Squares the piece on sq attacks (or defends), whatever stands there.
        public int[] AttacksFrom(int sq)
        {
            var found = new List<int>();
            int p = Squares[sq];
            if (p == 0) return found.ToArray();
            int type = Math.Abs(p), file = FileOf(sq), rank = RankOf(sq);
            if (type == PAWN)
            {
                int r = rank + (p > 0 ? 1 : -1);
                foreach (int df in new[] { -1, 1 }) if (OnBoard(file + df, r)) found.Add(r * 8 + file + df);
            }
            else if (type == KNIGHT || type == KING)
            {
                foreach (var step in type == KNIGHT ? KNIGHT_STEPS : KING_STEPS)
                    if (OnBoard(file + step[0], rank + step[1])) found.Add((rank + step[1]) * 8 + file + step[0]);
            }
            else
            {
                var directions = new List<int[]>();
                if (type != ROOK) directions.AddRange(DIAGONALS);
                if (type != BISHOP) directions.AddRange(LINES);
                foreach (var d in directions)
                {
                    int f = file + d[0], r = rank + d[1];
                    while (OnBoard(f, r))
                    {
                        found.Add(r * 8 + f);
                        if (Squares[r * 8 + f] != 0) break;
                        f += d[0]; r += d[1];
                    }
                }
            }
            return found.ToArray();
        }

        public bool InCheck() { int king = KingSquare(WhiteToMove); return king >= 0 && IsAttacked(king, !WhiteToMove); }
        public bool IsCheckmate() { return InCheck() && LegalMoves().Length == 0; }
        public bool IsStalemate() { return !InCheck() && LegalMoves().Length == 0; }

        // --- Moves -----------------------------------------------------------------
        public Board Play(ChessMove m)
        {
            var next = Clone();
            int mover = Squares[m.From];
            int sign = mover > 0 ? 1 : -1;
            next.Squares[m.From] = 0;
            next.Squares[m.To] = (sbyte)(m.Promo != 0 ? sign * m.Promo : mover);
            if (m.IsEnPassant) next.Squares[m.To - 8 * sign] = 0;
            if (m.IsCastle)
            {
                bool shortSide = m.To > m.From;
                int rookFrom = shortSide ? m.From + 3 : m.From - 4, rookTo = shortSide ? m.From + 1 : m.From - 1;
                next.Squares[rookTo] = next.Squares[rookFrom];
                next.Squares[rookFrom] = 0;
            }
            next.Castling &= ~(RightsTouched(m.From) | RightsTouched(m.To));
            next.EpSquare = (m.Flags & ChessMove.DOUBLE_PUSH) != 0 ? (m.From + m.To) / 2 : -1;
            next.HalfMove = (Math.Abs(mover) == PAWN || m.IsCapture) ? 0 : HalfMove + 1;
            if (!WhiteToMove) next.FullMove = FullMove + 1;
            next.WhiteToMove = !WhiteToMove;
            return next;
        }

        static int RightsTouched(int sq)
        {
            switch (sq) { case 4: return 3; case 7: return 1; case 0: return 2; case 60: return 12; case 63: return 4; case 56: return 8; default: return 0; }
        }

        // Passes the turn: used to ask "what would this side threaten next?".
        public Board NullMove()
        {
            var next = Clone();
            next.WhiteToMove = !WhiteToMove;
            next.EpSquare = -1;
            return next;
        }

        List<ChessMove> PseudoMoves()
        {
            var moves = new List<ChessMove>();
            int sign = WhiteToMove ? 1 : -1;
            for (int sq = 0; sq < 64; sq++)
            {
                int p = Squares[sq];
                if (p == 0 || (p > 0) != WhiteToMove) continue;
                int type = Math.Abs(p), file = FileOf(sq), rank = RankOf(sq);
                if (type == PAWN)
                {
                    int r = rank + sign;
                    int lastRank = WhiteToMove ? 7 : 0, startRank = WhiteToMove ? 1 : 6;
                    if (OnBoard(file, r) && Squares[r * 8 + file] == 0)
                    {
                        AddPawn(moves, sq, r * 8 + file, 0, 0, r == lastRank);
                        int r2 = rank + 2 * sign;
                        if (rank == startRank && Squares[r2 * 8 + file] == 0) moves.Add(new ChessMove { From = sq, To = r2 * 8 + file, Piece = PAWN, Flags = ChessMove.DOUBLE_PUSH });
                    }
                    foreach (int df in new[] { -1, 1 })
                    {
                        if (!OnBoard(file + df, r)) continue;
                        int to = r * 8 + file + df, target = Squares[to];
                        if (target != 0 && (target > 0) != WhiteToMove) AddPawn(moves, sq, to, Math.Abs(target), 0, r == lastRank);
                        else if (to == EpSquare && target == 0) moves.Add(new ChessMove { From = sq, To = to, Piece = PAWN, Captured = PAWN, Flags = ChessMove.EN_PASSANT });
                    }
                    continue;
                }
                foreach (int to in AttacksFrom(sq))
                {
                    int target = Squares[to];
                    if (target != 0 && (target > 0) == WhiteToMove) continue;
                    moves.Add(new ChessMove { From = sq, To = to, Piece = type, Captured = Math.Abs(target) });
                }
                if (type == KING) AddCastles(moves, sq);
            }
            return moves;
        }

        static void AddPawn(List<ChessMove> moves, int from, int to, int captured, int flags, bool promotes)
        {
            if (!promotes) { moves.Add(new ChessMove { From = from, To = to, Piece = PAWN, Captured = captured, Flags = flags }); return; }
            foreach (int promo in new[] { QUEEN, ROOK, BISHOP, KNIGHT })
                moves.Add(new ChessMove { From = from, To = to, Piece = PAWN, Captured = captured, Promo = promo, Flags = flags });
        }

        void AddCastles(List<ChessMove> moves, int sq)
        {
            int home = WhiteToMove ? 4 : 60;
            if (sq != home) return;
            bool enemy = !WhiteToMove;
            int shortRight = WhiteToMove ? 1 : 4, longRight = WhiteToMove ? 2 : 8;
            sbyte rook = (sbyte)(WhiteToMove ? ROOK : -ROOK);
            if ((Castling & shortRight) != 0 && Squares[home + 3] == rook && Squares[home + 1] == 0 && Squares[home + 2] == 0
                && !IsAttacked(home, enemy) && !IsAttacked(home + 1, enemy) && !IsAttacked(home + 2, enemy))
                moves.Add(new ChessMove { From = home, To = home + 2, Piece = KING, Flags = ChessMove.CASTLE });
            if ((Castling & longRight) != 0 && Squares[home - 4] == rook && Squares[home - 1] == 0 && Squares[home - 2] == 0 && Squares[home - 3] == 0
                && !IsAttacked(home, enemy) && !IsAttacked(home - 1, enemy) && !IsAttacked(home - 2, enemy))
                moves.Add(new ChessMove { From = home, To = home - 2, Piece = KING, Flags = ChessMove.CASTLE });
        }

        public ChessMove[] LegalMoves()
        {
            var legal = new List<ChessMove>();
            foreach (var m in PseudoMoves())
            {
                var next = Play(m);
                int king = next.KingSquare(WhiteToMove);
                if (king >= 0 && !next.IsAttacked(king, !WhiteToMove)) legal.Add(m);
            }
            return legal.ToArray();
        }

        public ChessMove[] LegalMovesFrom(int sq) { return LegalMoves().Where(m => m.From == sq).ToArray(); }

        // The legal move from one square to another; promo 0 means a queen when promoting.
        public ChessMove FindMove(int from, int to, int promo)
        {
            foreach (var m in LegalMoves())
                if (m.From == from && m.To == to && (m.Promo == 0 || m.Promo == (promo == 0 ? QUEEN : promo))) return m;
            return null;
        }

        public bool NeedsPromotion(int from, int to)
        {
            return LegalMoves().Any(m => m.From == from && m.To == to && m.Promo != 0);
        }

        // Reads UCI; king-takes-own-rook ("e1h1") is read as castling too.
        public ChessMove ParseUci(string uci)
        {
            if (uci == null || uci.Length < 4) return null;
            int from = SquareIndex(uci.Substring(0, 2)), to = SquareIndex(uci.Substring(2, 2));
            if (from < 0 || to < 0) return null;
            int promo = uci.Length > 4 ? "pnbrqk".IndexOf(uci[4]) + 1 : 0;
            int mover = Squares[from];
            if (Math.Abs(mover) == KING && Squares[to] == (mover > 0 ? ROOK : -ROOK))
                to = to > from ? from + 2 : from - 2;
            foreach (var m in LegalMoves())
                if (m.From == from && m.To == to && m.Promo == promo) return m;
            return null;
        }

        public bool SameMove(ChessMove a, string uci)
        {
            var parsed = ParseUci(uci);
            return parsed != null && a != null && parsed.From == a.From && parsed.To == a.To && parsed.Promo == a.Promo;
        }

        // --- SAN -------------------------------------------------------------------
        public string San(ChessMove m)
        {
            string text;
            if (m.IsCastle) text = m.To > m.From ? "O-O" : "O-O-O";
            else
            {
                var b = new StringBuilder();
                if (m.Piece == PAWN)
                {
                    if (m.IsCapture) b.Append((char)('a' + FileOf(m.From))).Append('x');
                    b.Append(SquareName(m.To));
                    if (m.Promo != 0) b.Append('=').Append(PieceLetter(m.Promo));
                }
                else
                {
                    b.Append(PieceLetter(m.Piece));
                    var rivals = LegalMoves().Where(o => o.Piece == m.Piece && o.To == m.To && o.From != m.From).ToList();
                    if (rivals.Count > 0)
                    {
                        bool fileUnique = rivals.All(o => FileOf(o.From) != FileOf(m.From));
                        bool rankUnique = rivals.All(o => RankOf(o.From) != RankOf(m.From));
                        if (fileUnique) b.Append((char)('a' + FileOf(m.From)));
                        else if (rankUnique) b.Append((char)('1' + RankOf(m.From)));
                        else b.Append(SquareName(m.From));
                    }
                    if (m.IsCapture) b.Append('x');
                    b.Append(SquareName(m.To));
                }
                text = b.ToString();
            }
            var after = Play(m);
            if (after.InCheck()) text += after.LegalMoves().Length == 0 ? "#" : "+";
            return text;
        }

        public ChessMove ParseSan(string san)
        {
            string wanted = san.TrimEnd('+', '#', '!', '?');
            foreach (var m in LegalMoves())
                if (San(m).TrimEnd('+', '#') == wanted) return m;
            return null;
        }

        public int Material(bool white)
        {
            int total = 0;
            foreach (sbyte p in Squares) if (p != 0 && (p > 0) == white) total += PieceValue(p);
            return total;
        }

        public int Count(bool white, int type)
        {
            int count = 0;
            sbyte wanted = (sbyte)(white ? type : -type);
            foreach (sbyte p in Squares) if (p == wanted) count++;
            return count;
        }

        public static long Perft(Board board, int depth)
        {
            if (depth == 0) return 1;
            var moves = board.LegalMoves();
            if (depth == 1) return moves.Length;
            long total = 0;
            foreach (var m in moves) total += Perft(board.Play(m), depth - 1);
            return total;
        }
    }

    // A note shown in the explanation feed: the sentences, what kinds of facts
    // they are, and the squares to light up when the line is hovered.
    public sealed class ChessNote
    {
        public string Text = "";
        public List<string> Kinds = new List<string>();
        public List<int> Squares = new List<int>();
        public bool Has(string kind) { return Kinds.Contains(kind); }
        public int[] SquareArray() { return Squares.Distinct().ToArray(); }
        public string KindList() { return string.Join(" ", Kinds.ToArray()); }
    }

    // Turns moves into plain sentences. Every sentence comes from the board itself:
    // a fact is only stated when the attack maps prove it.
    public static class Narrator
    {
        static readonly string[] NAMES = { "", "pawn", "knight", "bishop", "rook", "queen", "king" };
        static readonly string[] PLURALS = { "", "pawns", "knights", "bishops", "rooks", "queens", "kings" };
        static readonly string[] COUNTS = { "no", "a", "two", "three", "four", "five", "six", "seven", "eight" };

        sealed class Fact
        {
            public string Kind, Text;
            public int[] Squares;
            public Fact(string kind, string text, params int[] squares) { Kind = kind; Text = text; Squares = squares; }
        }

        public static string PieceName(int piece) { return NAMES[Math.Abs(piece)]; }
        public static string PieceOn(Board b, int sq) { return "the " + PieceName(b.Squares[sq]) + " on " + Board.SquareName(sq); }
        static string Sq(int sq) { return Board.SquareName(sq); }

        static string JoinList(IList<string> items)
        {
            if (items.Count == 0) return "";
            if (items.Count == 1) return items[0];
            return string.Join(", ", items.Take(items.Count - 1).ToArray()) + " and " + items[items.Count - 1];
        }

        static string Capital(string text) { return text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text.Substring(1); }

        static bool IsEnemy(Board b, int sq, bool white) { return b.Squares[sq] != 0 && (b.Squares[sq] > 0) != white; }

        // --- What a move does ------------------------------------------------------
        static List<Fact> MoveFacts(Board before, ChessMove m, ChessMove followUp)
        {
            var facts = new List<Fact>();
            bool me = before.WhiteToMove;
            int sign = me ? 1 : -1;
            var after = before.Play(m);
            int type = Math.Abs(after.Squares[m.To]);
            int enemyKing = after.KingSquare(!me);
            bool givesCheck = after.InCheck();
            bool mate = givesCheck && after.LegalMoves().Length == 0;

            if (m.IsCapture)
            {
                int taken = m.IsEnPassant ? m.To - 8 * sign : m.To;
                bool defended = before.IsAttacked(taken, !me);
                string victim = NAMES[m.Captured] + " on " + Sq(taken);
                int guarded = -1;
                if (followUp != null && before.AttacksFrom(taken).Contains(followUp.To) && IsGuardedBy(before, followUp.To, !me, taken)) guarded = followUp.To;
                if (guarded >= 0)
                {
                    string rest = after.IsAttacked(guarded, !me) ? "" : ", so " + Sq(guarded) + " is left unguarded";
                    facts.Add(new Fact("removesDefender", "Takes the " + victim + " that was guarding " + Sq(guarded) + rest + ".", taken, guarded));
                }
                else if (!defended) facts.Add(new Fact("hanging", "Takes the undefended " + victim + ".", taken));
                else facts.Add(new Fact("capture", "Takes the " + victim + ".", taken));
            }

            if (m.Promo != 0)
            {
                if (m.Promo == Board.QUEEN) facts.Add(new Fact("promotion", "Promotes to a queen.", m.To));
                else
                {
                    var asQueen = before.Play(new ChessMove { From = m.From, To = m.To, Piece = m.Piece, Captured = m.Captured, Promo = Board.QUEEN, Flags = m.Flags });
                    string why = asQueen.IsStalemate() ? ", because a queen would be stalemate" : (m.Promo == Board.KNIGHT && givesCheck ? ", which gives check" : "");
                    facts.Add(new Fact("underPromotion", "Promotes to a " + NAMES[m.Promo] + why + ".", m.To));
                }
            }

            if (mate)
            {
                facts.Add(new Fact("mate", "Checkmate. " + MateExplanation(after), MateSquares(after)));
                return facts;
            }

            if (type == Board.PAWN && m.Promo == 0) AddPassedPawn(facts, after, m.To, me);

            if (givesCheck)
            {
                int[] checkers = after.Attackers(enemyKing, me);
                int rookSquare = m.IsCastle ? (m.To > m.From ? m.From + 1 : m.From - 1) : -1;
                if (checkers.Length >= 2)
                    facts.Add(new Fact("doubleCheck", "Double check from " + PieceOn(after, checkers[0]) + " and " + PieceOn(after, checkers[1]) + ": only a king move can answer it.", checkers[0], checkers[1], enemyKing));
                else if (checkers.Length == 1 && checkers[0] != m.To && checkers[0] != rookSquare)
                    facts.Add(new Fact("discoveredCheck", "Discovered check from " + PieceOn(after, checkers[0]) + ".", checkers[0], enemyKing));
                else facts.Add(new Fact("check", "Check.", enemyKing));
            }

            // New targets of the moved piece.
            var hitsBefore = new HashSet<int>(before.AttacksFrom(m.From));
            bool promoted = m.Promo != 0;
            var targets = new List<int>();
            foreach (int t in after.AttacksFrom(m.To))
            {
                if (!IsEnemy(after, t, me) || (hitsBefore.Contains(t) && !promoted && !m.IsCastle)) continue;
                int target = Math.Abs(after.Squares[t]);
                bool undefended = !after.IsAttacked(t, !me);
                if (type == Board.KING && !undefended) continue;
                if (target == Board.KING || (type != Board.KING && Board.PieceValue(target) > Board.PieceValue(type)) || (undefended && (Board.PieceValue(target) >= 3 || type == Board.KING))) targets.Add(t);
            }
            targets = targets.OrderByDescending(t => Math.Abs(after.Squares[t]) == Board.KING ? 100 : Board.PieceValue(after.Squares[t])).ToList();
            if (targets.Count >= 2)
            {
                facts.Add(new Fact("fork", "Forks " + JoinList(targets.Select(t => PieceOn(after, t)).ToList()) + ".", targets.Concat(new[] { m.To }).ToArray()));
                facts.RemoveAll(f => f.Kind == "check");
            }
            else if (targets.Count == 1 && Math.Abs(after.Squares[targets[0]]) != Board.KING)
                facts.Add(new Fact("attack", "Attacks " + PieceOn(after, targets[0]) + (after.IsAttacked(targets[0], !me) ? "" : ", which is undefended") + ".", targets[0], m.To));

            // Pins and skewers by the moved piece, if it slides.
            if (type == Board.BISHOP || type == Board.ROOK || type == Board.QUEEN)
            {
                var old = new HashSet<string>(LinePairs(before, m.From, type).Select(p => p.Kind + p.Squares[0] + "-" + p.Squares[1]));
                foreach (var pair in LinePairs(after, m.To, type))
                {
                    if (old.Contains(pair.Kind + pair.Squares[0] + "-" + pair.Squares[1])) continue;
                    facts.Add(new Fact(pair.Kind, pair.Text, pair.Squares[0], pair.Squares[1], m.To));
                    if (pair.Kind == "skewer") facts.RemoveAll(f => f.Kind == "check");
                }
            }

            // Lines opened by the piece that moved away.
            for (int sq = 0; sq < 64; sq++)
            {
                int p = before.Squares[sq];
                if (sq == m.From || p == 0 || (p > 0) != me) continue;
                int slider = Math.Abs(p);
                if (slider != Board.BISHOP && slider != Board.ROOK && slider != Board.QUEEN) continue;
                int[] d = Direction(sq, m.From, slider);
                if (d == null || !ClearBetween(before, sq, m.From, d)) continue;
                int hit = FirstPiece(after, sq, d);
                if (hit < 0 || !IsEnemy(after, hit, me) || Math.Abs(after.Squares[hit]) == Board.KING) continue;
                int value = Board.PieceValue(after.Squares[hit]);
                if (value > Board.PieceValue(slider) || (!after.IsAttacked(hit, !me) && value >= 3))
                    facts.Add(new Fact("discoveredAttack", "Uncovers an attack: " + PieceOn(after, sq) + " now hits " + PieceOn(after, hit) + ".", sq, hit));
            }

            // A piece left where it can be taken for less than it is worth.
            int worth = Board.PieceValue(type);
            if (worth >= 3)
            {
                var takers = after.LegalMoves().Where(x => x.To == m.To).ToList();
                if (takers.Count > 0)
                {
                    bool covered = after.IsAttacked(m.To, me);
                    var taker = takers.OrderBy(x => x.Piece == Board.KING ? 100 : Board.PieceValue(x.Piece)).First();
                    int cheapest = taker.Piece == Board.KING ? 100 : Board.PieceValue(taker.Piece);
                    int risked = !covered ? worth : Math.Max(0, worth - cheapest);
                    // Said plainly, without calling it good or bad: the move might be a blunder.
                    if (risked > Board.PieceValue(m.Captured))
                        facts.Add(new Fact("sacrifice", "The " + NAMES[type] + " on " + Sq(m.To) + " can now be taken by " + PieceOn(after, taker.From) + ".", m.To, taker.From));
                }
            }

            // A quiet move: what would it threaten if the opponent did nothing?
            if (!m.IsCapture && !givesCheck && m.Promo == 0)
            {
                var again = after.NullMove();
                foreach (var x in again.LegalMoves())
                    if (again.Play(x).IsCheckmate())
                    {
                        facts.Add(new Fact("threatMate", "Threatens " + again.San(x) + ".", x.From, x.To));
                        break;
                    }
            }
            return facts;
        }

        // A pawn no enemy pawn can stop; and, with only kings and pawns left, whether
        // the enemy king is outside the pawn's square (it can't catch it in time).
        static void AddPassedPawn(List<Fact> facts, Board after, int sq, bool white)
        {
            int file = Board.FileOf(sq), rank = Board.RankOf(sq), step = white ? 1 : -1, last = white ? 7 : 0;
            int stepsLeft = Math.Abs(last - rank);
            if (stepsLeft > 4 || stepsLeft == 0) return;
            sbyte enemyPawn = (sbyte)(white ? -Board.PAWN : Board.PAWN);
            for (int r = rank + step; r != last + step; r += step)
                for (int f = Math.Max(0, file - 1); f <= Math.Min(7, file + 1); f++)
                    if (after.Squares[r * 8 + f] == enemyPawn) return;
            int promo = last * 8 + file;
            bool pathClear = true;
            for (int r = rank + step; r != last + step; r += step) if (after.Squares[r * 8 + file] != 0) pathClear = false;
            bool onlyPawns = true;
            for (int s = 0; s < 64; s++)
            {
                int p = after.Squares[s];
                if (p != 0 && (p > 0) != white && Math.Abs(p) != Board.PAWN && Math.Abs(p) != Board.KING) onlyPawns = false;
            }
            int king = after.KingSquare(!white);
            int distance = king < 0 ? 99 : Math.Max(Math.Abs(Board.FileOf(king) - file), Math.Abs(Board.RankOf(king) - last));
            string side = white ? "black" : "white";
            // The king moves first, so it catches the pawn if it is within one step of the pawn's square.
            if (onlyPawns && pathClear && distance > stepsLeft + 1)
                facts.Add(new Fact("outrunsKing", "A passed pawn, and the king on " + Sq(king) + " is outside its square: it can't catch the pawn before it reaches " + Sq(promo) + ".", sq, promo, king));
            else
                facts.Add(new Fact("passedPawn", "A passed pawn: no " + side + " pawn can block or take it on the way to " + Sq(promo) + ".", sq, promo));
        }

        // Is the piece on `guard` one of the pieces defending `sq` for that side?
        static bool IsGuardedBy(Board b, int sq, bool white, int guard)
        {
            return b.Attackers(sq, white).Contains(guard);
        }

        static int[] Direction(int from, int to, int slider)
        {
            int df = Board.FileOf(to) - Board.FileOf(from), dr = Board.RankOf(to) - Board.RankOf(from);
            if (df == 0 && dr == 0) return null;
            bool straight = df == 0 || dr == 0, diagonal = Math.Abs(df) == Math.Abs(dr);
            if (straight && slider == Board.BISHOP) return null;
            if (diagonal && slider == Board.ROOK) return null;
            if (!straight && !diagonal) return null;
            return new[] { Math.Sign(df), Math.Sign(dr) };
        }

        static bool ClearBetween(Board b, int from, int to, int[] d)
        {
            int f = Board.FileOf(from) + d[0], r = Board.RankOf(from) + d[1];
            while (r * 8 + f != to)
            {
                if (b.Squares[r * 8 + f] != 0) return false;
                f += d[0]; r += d[1];
            }
            return true;
        }

        static int FirstPiece(Board b, int from, int[] d)
        {
            int f = Board.FileOf(from) + d[0], r = Board.RankOf(from) + d[1];
            while (Board.OnBoard(f, r))
            {
                if (b.Squares[r * 8 + f] != 0) return r * 8 + f;
                f += d[0]; r += d[1];
            }
            return -1;
        }

        // Pins and skewers along the lines of a slider standing on sq.
        static List<Fact> LinePairs(Board b, int sq, int type)
        {
            var found = new List<Fact>();
            bool white = b.Squares[sq] > 0;
            var directions = new List<int[]>();
            if (type != Board.ROOK) directions.AddRange(Board.DIAGONALS);
            if (type != Board.BISHOP) directions.AddRange(Board.LINES);
            int own = Board.PieceValue(type);
            foreach (var d in directions)
            {
                int first = FirstPiece(b, sq, d);
                if (first < 0 || !IsEnemy(b, first, white)) continue;
                int second = FirstPiece(b, first, d);
                if (second < 0 || !IsEnemy(b, second, white)) continue;
                int front = Math.Abs(b.Squares[first]), back = Math.Abs(b.Squares[second]);
                bool backLoose = !b.IsAttacked(second, !white);
                if (front == Board.KING)
                {
                    if (Board.PieceValue(back) >= 3 && (backLoose || Board.PieceValue(back) >= own))
                        found.Add(new Fact("skewer", "Skewers " + PieceOn(b, first) + ": when it steps aside, " + PieceOn(b, second) + " behind it can be taken.", first, second));
                }
                else if (back == Board.KING)
                    found.Add(new Fact("pin", "Pins " + PieceOn(b, first) + " to the king.", first, second));
                else if (Board.PieceValue(back) > Board.PieceValue(front) && (backLoose || Board.PieceValue(back) > own))
                    found.Add(new Fact("pin", "Pins " + PieceOn(b, first) + " to " + PieceOn(b, second) + ".", first, second));
                else if (Board.PieceValue(front) > Board.PieceValue(back) && Board.PieceValue(front) > own && Board.PieceValue(back) >= 3 && (backLoose || Board.PieceValue(back) >= own))
                    found.Add(new Fact("skewer", "Skewers " + PieceOn(b, first) + ": when it moves away, " + PieceOn(b, second) + " behind it can be taken.", first, second));
            }
            return found;
        }

        // --- Checkmate ---------------------------------------------------------------
        public static string MateExplanation(Board mated)
        {
            bool loser = mated.WhiteToMove;
            int king = mated.KingSquare(loser);
            if (king < 0) return "";
            var open = mated.Clone();
            open.Squares[king] = 0; // squares behind the king along the checking line count as covered
            var covered = new Dictionary<int, List<int>>();
            var blocked = new List<int>();
            var guardedPieces = new List<string>();
            int file = Board.FileOf(king), rank = Board.RankOf(king);
            for (int df = -1; df <= 1; df++)
                for (int dr = -1; dr <= 1; dr++)
                {
                    if ((df == 0 && dr == 0) || !Board.OnBoard(file + df, rank + dr)) continue;
                    int s = (rank + dr) * 8 + file + df;
                    int p = mated.Squares[s];
                    if (p != 0 && (p > 0) == loser) { blocked.Add(s); continue; }
                    int[] guards = open.Attackers(s, !loser);
                    if (guards.Length == 0) continue;
                    int guard = guards.OrderBy(g => Math.Abs(open.Squares[g]) == Board.KING ? 100 : Board.PieceValue(open.Squares[g])).First();
                    if (p != 0) { guardedPieces.Add(PieceOn(mated, s) + " is protected by " + PieceOn(mated, guard)); continue; }
                    if (!covered.ContainsKey(guard)) covered[guard] = new List<int>();
                    covered[guard].Add(s);
                }
            var clauses = new List<string>();
            foreach (var pair in covered)
                clauses.Add(JoinList(pair.Value.Select(Sq).ToList()) + (pair.Value.Count == 1 ? " is" : " are") + " covered by " + PieceOn(mated, pair.Key));
            clauses.AddRange(guardedPieces);
            if (blocked.Count > 0)
            {
                var kinds = blocked.Select(s => Math.Abs(mated.Squares[s])).Distinct().ToList();
                string what = kinds.Count == 1 ? (blocked.Count == 1 ? NAMES[kinds[0]] : PLURALS[kinds[0]]) : (blocked.Count == 1 ? "piece" : "pieces");
                clauses.Add(JoinList(blocked.Select(Sq).ToList()) + (blocked.Count == 1 ? " is" : " are") + " blocked by its own " + what);
            }
            int[] checkers = mated.Attackers(king, !loser);
            if (checkers.Length == 1)
            {
                // It is mate, so the checker can't be taken (an adjacent one is covered above).
                int checker = checkers[0];
                bool adjacent = Math.Abs(Board.FileOf(checker) - file) <= 1 && Math.Abs(Board.RankOf(checker) - rank) <= 1;
                int kind = Math.Abs(mated.Squares[checker]);
                bool blockable = !adjacent && kind != Board.KNIGHT && kind != Board.PAWN;
                if (!adjacent) clauses.Add("nothing can take " + PieceOn(mated, checker) + (blockable ? " or block its check" : ""));
            }
            string lead = checkers.Length >= 2 ? "Double check, and the king on " + Sq(king) + " has nowhere to go" : "The king on " + Sq(king) + " has nowhere to go";
            if (clauses.Count == 0) return lead + ".";
            return lead + ": " + string.Join("; ", clauses.ToArray()) + ".";
        }

        static int[] MateSquares(Board mated)
        {
            int king = mated.KingSquare(mated.WhiteToMove);
            return new[] { king }.Concat(mated.Attackers(king, !mated.WhiteToMove)).ToArray();
        }

        // --- Notes for the feed -------------------------------------------------------
        static readonly string[] ORDER = { "escape", "onlyMove", "deflection", "attraction", "removesDefender", "hanging", "capture", "promotion", "underPromotion", "mate", "doubleCheck", "discoveredCheck", "fork", "pin", "skewer", "discoveredAttack", "attack", "check", "sacrifice", "threatMate", "outrunsKing", "passedPawn" };

        static ChessNote Compose(List<Fact> facts, int limit)
        {
            var note = new ChessNote();
            var ordered = facts.OrderBy(f => Array.IndexOf(ORDER, f.Kind) < 0 ? 99 : Array.IndexOf(ORDER, f.Kind)).ToList();
            var sentences = new List<string>();
            foreach (var f in ordered)
            {
                if (sentences.Count >= limit && f.Kind != "mate") continue;
                sentences.Add(f.Text);
                note.Kinds.Add(f.Kind);
                note.Squares.AddRange(f.Squares);
            }
            note.Text = string.Join(" ", sentences.ToArray());
            return note;
        }

        // What a move does, for either side. followUp is the same side's next move, if known.
        public static ChessNote Describe(Board before, ChessMove move, ChessMove followUp)
        {
            return Compose(MoveFacts(before, move, followUp), 3);
        }

        // The opponent's answer inside a puzzle line.
        public static ChessNote ReplyNote(Board before, ChessMove reply, ChessMove previous, ChessMove next)
        {
            var facts = new List<Fact>();
            bool me = before.WhiteToMove;
            var after = before.Play(reply);
            var legal = before.LegalMoves();

            if (before.InCheck())
            {
                int king = before.KingSquare(me);
                int[] checkers = before.Attackers(king, !me);
                if (reply.Piece == Board.KING && !reply.IsCapture) facts.Add(new Fact("escape", "The king steps out of check.", reply.To));
                else if (checkers.Contains(reply.To)) facts.Add(new Fact("escape", "Takes the checking " + NAMES[reply.Captured] + ".", reply.To));
                else if (reply.Piece != Board.KING) facts.Add(new Fact("escape", "Blocks the check.", reply.To));
            }
            if (legal.Length == 1) facts.Add(new Fact("onlyMove", "The only legal move.", reply.To));
            else if (legal.Length <= 40 && !AllowsMateInOne(after) && legal.All(x => x.Uci() == reply.Uci() || AllowsMateInOne(before.Play(x))))
                facts.Add(new Fact("onlyMove", "The only move that stops mate in one.", reply.To));

            var moveFacts = MoveFacts(before, reply, null).Where(f => f.Kind != "sacrifice" && f.Kind != "threatMate").ToList();
            if (facts.Any(f => f.Kind == "escape") && reply.IsCapture) moveFacts.RemoveAll(f => f.Kind == "capture" || f.Kind == "hanging");
            facts.AddRange(moveFacts);

            if (next != null)
            {
                int target = next.To;
                bool guardedBefore = reply.To != target && before.AttacksFrom(reply.From).Contains(target) && IsGuardedBy(before, target, me, reply.From);
                bool guardedAfter = after.AttacksFrom(reply.To).Contains(target);
                if (guardedBefore && !guardedAfter)
                {
                    string rest = after.IsAttacked(target, me) ? "it no longer guards " + Sq(target) : Sq(target) + " is no longer guarded";
                    facts.Add(new Fact("deflection", "That pulls the " + NAMES[reply.Piece] + " away from " + Sq(target) + ": " + rest + ".", reply.To, target));
                }
                if (previous != null && reply.IsCapture && reply.To == previous.To && (reply.Piece == Board.KING || Board.PieceValue(reply.Piece) >= 3))
                {
                    var afterNext = after.Play(next);
                    if (next.To == reply.To)
                        facts.Add(new Fact("attraction", "That brings the " + NAMES[reply.Piece] + " to " + Sq(reply.To) + ", where the next move takes it.", reply.To));
                    else if (afterNext.AttacksFrom(next.To).Contains(reply.To) || (reply.Piece == Board.KING && afterNext.InCheck()))
                        facts.Add(new Fact("attraction", "That brings the " + NAMES[reply.Piece] + " to " + Sq(reply.To) + ", right where the next move hits it.", reply.To));
                }
            }
            return Compose(facts, 3);
        }

        static bool AllowsMateInOne(Board position)
        {
            foreach (var x in position.LegalMoves())
            {
                var next = position.Play(x);
                if (next.InCheck() && next.LegalMoves().Length == 0) return true;
            }
            return false;
        }

        // A line of UCI moves as numbered SAN ("33...Qd6 34.Qe8 Qd1+"), stopping at the
        // first move that doesn't fit the board.
        public static string LineSan(Board start, string[] moves, int max)
        {
            var parts = new List<string>();
            var position = start;
            for (int i = 0; i < moves.Length && i < max; i++)
            {
                var m = position.ParseUci(moves[i]);
                if (m == null) break;
                string san = position.San(m);
                if (position.WhiteToMove) parts.Add(position.FullMove + "." + san);
                else parts.Add(i == 0 ? position.FullMove + "..." + san : san);
                position = position.Play(m);
            }
            return string.Join(" ", parts.ToArray());
        }

        // The first hint: the idea, only when a detector confirms it on this very move.
        public static string IdeaHint(Board before, ChessMove solution, ChessMove followUp, string[] themes, int solverMovesLeft)
        {
            if (themes.Any(t => t.StartsWith("mateIn")))
                return solverMovesLeft == 1 ? "There's a mate in one." : "There's a forced mate in " + solverMovesLeft + ".";
            var kinds = MoveFacts(before, solution, followUp).Select(f => f.Kind).ToList();
            if (kinds.Contains("mate")) return "There's a mate in one.";
            if (kinds.Contains("doubleCheck")) return "Look for a double check.";
            if (kinds.Contains("fork")) return "Look for a fork.";
            if (kinds.Contains("pin")) return "Look for a pin.";
            if (kinds.Contains("skewer")) return "Look for a skewer.";
            if (kinds.Contains("discoveredCheck") || kinds.Contains("discoveredAttack")) return "Look for a discovered attack.";
            if (kinds.Contains("underPromotion")) return "Look for an unusual promotion.";
            if (kinds.Contains("promotion")) return "Look for a promotion.";
            if (kinds.Contains("removesDefender")) return "Look for a defender you can remove.";
            if (kinds.Contains("hanging")) return "Something is left undefended.";
            if (kinds.Contains("sacrifice")) return "Look for a sacrifice.";
            if (kinds.Contains("threatMate")) return "Look for a quiet move that threatens mate.";
            return null;
        }

        // What the whole line won, from the position the solver faced to the end.
        public static string Summary(Board start, Board end, bool solverWhite, string[] themes, int solverMoves)
        {
            if (end.IsCheckmate()) return solverMoves == 1 ? "Checkmate in one." : "Checkmate in " + solverMoves + " moves.";
            int net = (end.Material(solverWhite) - end.Material(!solverWhite)) - (start.Material(solverWhite) - start.Material(!solverWhite));
            var won = new List<string>();
            var lost = new List<string>();
            int newQueens = Math.Max(0, end.Count(solverWhite, Board.QUEEN) - start.Count(solverWhite, Board.QUEEN));
            for (int type = Board.QUEEN; type >= Board.PAWN; type--)
            {
                int gone = start.Count(!solverWhite, type) - end.Count(!solverWhite, type);
                if (gone > 0) won.Add(gone == 1 ? "a " + NAMES[type] : COUNTS[Math.Min(gone, 8)] + " " + PLURALS[type]);
                int mine = start.Count(solverWhite, type) - end.Count(solverWhite, type);
                if (type == Board.PAWN) mine -= newQueens;
                if (mine > 0) lost.Add(mine == 1 ? "a " + NAMES[type] : COUNTS[Math.Min(mine, 8)] + " " + PLURALS[type]);
            }
            string extra = newQueens > 0 ? " and makes a new queen" : "";
            if (won.Count == 0 && net <= 0)
            {
                if (themes.Contains("crushing") || themes.Contains("advantage")) return "Material is level" + extra + ", but the position is now clearly winning.";
                if (themes.Contains("equality")) return "This holds the balance.";
                return "Material is level" + extra + ".";
            }
            string score = " (" + (net >= 0 ? "+" : "") + net + ").";
            if (won.Count == 0)
            {
                if (newQueens > 0) return "Makes a new queen" + (lost.Count > 0 ? ", giving up " + JoinList(lost) + " on the way" : "") + score;
                return "Comes out ahead" + (lost.Count > 0 ? " despite giving up " + JoinList(lost) : "") + score;
            }
            string text = "Wins " + JoinList(won);
            if (lost.Count > 0) text += " for " + JoinList(lost);
            return text + extra + score;
        }
    }

    // --- Glicko-2, the rating system Lichess uses -------------------------------------
    public sealed class GlickoRating
    {
        public double Rating = Glicko2.DEFAULT_RATING, Deviation = Glicko2.DEFAULT_DEVIATION, Volatility = Glicko2.DEFAULT_VOLATILITY;
    }

    public static class Glicko2
    {
        public const double TAU = 0.75, DEFAULT_RATING = 1500, DEFAULT_DEVIATION = 500, DEFAULT_VOLATILITY = 0.09;
        public const double MIN_DEVIATION = 45, MAX_DEVIATION = 500, MAX_VOLATILITY = 0.1;
        const double SCALE = 173.7178, EPSILON = 0.000001;

        static double G(double phi) { return 1 / Math.Sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI)); }

        public static GlickoRating Update(GlickoRating player, double oppRating, double oppDeviation, double score)
        {
            var next = UpdateMany(player, new[] { oppRating }, new[] { oppDeviation }, new[] { score }, TAU);
            next.Deviation = Math.Max(MIN_DEVIATION, Math.Min(MAX_DEVIATION, next.Deviation));
            next.Volatility = Math.Min(MAX_VOLATILITY, next.Volatility);
            return next;
        }

        // Glickman's algorithm for one rating period; no clamping, so the paper's example can be checked.
        public static GlickoRating UpdateMany(GlickoRating player, double[] oppRatings, double[] oppDeviations, double[] scores, double tau)
        {
            double mu = (player.Rating - 1500) / SCALE, phi = player.Deviation / SCALE, sigma = player.Volatility;
            double vInverse = 0, deltaSum = 0;
            for (int i = 0; i < oppRatings.Length; i++)
            {
                double muJ = (oppRatings[i] - 1500) / SCALE, g = G(oppDeviations[i] / SCALE);
                double e = 1 / (1 + Math.Exp(-g * (mu - muJ)));
                vInverse += g * g * e * (1 - e);
                deltaSum += g * (scores[i] - e);
            }
            double v = 1 / vInverse, delta = v * deltaSum;
            double a = Math.Log(sigma * sigma);
            Func<double, double> f = x =>
            {
                double ex = Math.Exp(x), d = phi * phi + v + ex;
                return ex * (delta * delta - phi * phi - v - ex) / (2 * d * d) - (x - a) / (tau * tau);
            };
            double A = a, B;
            if (delta * delta > phi * phi + v) B = Math.Log(delta * delta - phi * phi - v);
            else
            {
                int k = 1;
                while (f(a - k * tau) < 0) k++;
                B = a - k * tau;
            }
            double fA = f(A), fB = f(B);
            int guard = 0;
            while (Math.Abs(B - A) > EPSILON && guard++ < 100)
            {
                double C = A + (A - B) * fA / (fB - fA), fC = f(C);
                if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
                B = C; fB = fC;
            }
            double newSigma = Math.Exp(A / 2);
            double phiStar = Math.Sqrt(phi * phi + newSigma * newSigma);
            double newPhi = 1 / Math.Sqrt(1 / (phiStar * phiStar) + 1 / v);
            double newMu = mu + newPhi * newPhi * deltaSum;
            return new GlickoRating { Rating = SCALE * newMu + 1500, Deviation = SCALE * newPhi, Volatility = newSigma };
        }
    }

    // --- The bundled puzzles --------------------------------------------------------------
    public sealed class Puzzle
    {
        public string Id, Fen, Game;
        public string[] Moves, Themes;
        public int Rating, Deviation, Popularity, Plays, Index;
        public bool HasTheme(string theme) { return Themes.Contains(theme); }
        public int SolverMoves { get { return Moves.Length / 2; } }
    }

    public sealed class PickResult
    {
        public Puzzle Puzzle;
        public int Window;           // how far from the target the search had to look
        public bool Nearest;         // nothing within reach: the closest one was taken
        public bool FellBackToMix;   // the chosen theme had nothing left
    }

    public sealed class PuzzleStore
    {
        Puzzle[] puzzles = new Puzzle[0];
        int[] ratings = new int[0];
        readonly Dictionary<string, Puzzle> byId = new Dictionary<string, Puzzle>();
        readonly Dictionary<string, int[]> byTheme = new Dictionary<string, int[]>();

        public int Count { get { return puzzles.Length; } }
        public Puzzle Get(string id) { Puzzle p; return id != null && byId.TryGetValue(id, out p) ? p : null; }
        public Puzzle At(int index) { return puzzles[index]; }
        public int ThemeCount(string theme) { int[] list; return byTheme.TryGetValue(theme, out list) ? list.Length : 0; }
        public string[] Themes() { return byTheme.Keys.OrderBy(k => k).ToArray(); }

        public static PuzzleStore Load(string path) { return FromLines(File.ReadAllLines(path, Encoding.ASCII)); }

        public static PuzzleStore FromLines(IEnumerable<string> lines)
        {
            var store = new PuzzleStore();
            var list = new List<Puzzle>();
            foreach (var line in lines)
            {
                if (line.Length == 0 || line[0] == '#') continue;
                var f = line.Split('|');
                if (f.Length != 9) continue;
                var p = new Puzzle { Id = f[0], Fen = f[1], Moves = f[2].Split(' '), Themes = f[7].Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries), Game = f[8] };
                if (!int.TryParse(f[3], out p.Rating) || !int.TryParse(f[4], out p.Deviation)) continue;
                int.TryParse(f[5], out p.Popularity);
                int.TryParse(f[6], out p.Plays);
                if (p.Moves.Length < 2 || store.byId.ContainsKey(p.Id)) continue;
                store.byId[p.Id] = p;
                list.Add(p);
            }
            store.puzzles = list.OrderBy(p => p.Rating).ThenBy(p => p.Id, StringComparer.Ordinal).ToArray();
            store.ratings = new int[store.puzzles.Length];
            var themes = new Dictionary<string, List<int>>();
            for (int i = 0; i < store.puzzles.Length; i++)
            {
                var p = store.puzzles[i];
                p.Index = i;
                store.ratings[i] = p.Rating;
                foreach (var t in p.Themes)
                {
                    if (!themes.ContainsKey(t)) themes[t] = new List<int>();
                    themes[t].Add(i);
                }
            }
            foreach (var pair in themes) store.byTheme[pair.Key] = pair.Value.ToArray();
            return store;
        }

        // Picks a puzzle near the target rating, widening the search 100 points at a
        // time; falls back to the nearest one, then to the whole set.
        public PickResult Pick(string theme, int target, HashSet<string> exclude, Random rng)
        {
            int[] pool = null;
            bool mix = string.IsNullOrEmpty(theme) || theme == "mix";
            if (!mix && !byTheme.TryGetValue(theme, out pool)) mix = true;
            var result = PickFrom(mix ? null : pool, target, exclude, rng);
            if (result != null) return result;
            if (!mix)
            {
                result = PickFrom(null, target, exclude, rng);
                if (result != null) { result.FellBackToMix = true; return result; }
            }
            // Everything solved: start over rather than come up empty.
            result = PickFrom(null, target, new HashSet<string>(), rng);
            return result;
        }

        PickResult PickFrom(int[] pool, int target, HashSet<string> exclude, Random rng)
        {
            int size = pool == null ? puzzles.Length : pool.Length;
            if (size == 0) return null;
            Func<int, Puzzle> at = i => pool == null ? puzzles[i] : puzzles[pool[i]];
            for (int window = 100; window <= 1300; window += 100)
            {
                int low = LowerBound(at, size, target - window), high = LowerBound(at, size, target + window + 1);
                var inner = new List<Puzzle>();
                var outer = new List<Puzzle>();
                for (int i = low; i < high; i++)
                {
                    var p = at(i);
                    if (exclude.Contains(p.Id)) continue;
                    if (Math.Abs(p.Rating - target) <= window / 2) inner.Add(p); else outer.Add(p);
                }
                if (inner.Count + outer.Count == 0) continue;
                // Twice as likely to land in the inner half of the window.
                int innerWeight = inner.Count * 2, roll = rng.Next(innerWeight + outer.Count);
                var chosen = roll < innerWeight ? inner[roll / 2] : outer[roll - innerWeight];
                return new PickResult { Puzzle = chosen, Window = window };
            }
            Puzzle best = null;
            for (int i = 0; i < size; i++)
            {
                var p = at(i);
                if (exclude.Contains(p.Id)) continue;
                if (best == null || Math.Abs(p.Rating - target) < Math.Abs(best.Rating - target)) best = p;
            }
            return best == null ? null : new PickResult { Puzzle = best, Window = Math.Abs(best.Rating - target), Nearest = true };
        }

        static int LowerBound(Func<int, Puzzle> at, int size, int rating)
        {
            int low = 0, high = size;
            while (low < high)
            {
                int mid = (low + high) / 2;
                if (at(mid).Rating < rating) low = mid + 1; else high = mid;
            }
            return low;
        }
    }

    // Reads the puzzle file on a background thread while the window is being built.
    public sealed class PuzzleLoader
    {
        Thread worker;
        PuzzleStore store;
        Exception failure;

        public static PuzzleLoader Begin(string path)
        {
            var loader = new PuzzleLoader();
            loader.worker = new Thread(() =>
            {
                try { loader.store = PuzzleStore.Load(path); }
                catch (Exception e) { loader.failure = e; }
            }) { IsBackground = true, Name = "puzzle-loader" };
            loader.worker.Start();
            return loader;
        }

        public PuzzleStore Wait()
        {
            worker.Join();
            if (failure != null) throw new IOException("could not read the puzzles: " + failure.Message, failure);
            return store;
        }
    }

    // Checks every bundled puzzle replays legally and that its mate tags hold.
    public static class PuzzleCheck
    {
        public static string[] Problems(PuzzleStore store)
        {
            var problems = new List<string>();
            for (int i = 0; i < store.Count; i++)
            {
                var p = store.At(i);
                try
                {
                    var board = Board.FromFen(p.Fen);
                    foreach (var uci in p.Moves)
                    {
                        var m = board.ParseUci(uci);
                        if (m == null) { problems.Add(p.Id + " illegal " + uci); board = null; break; }
                        board = board.Play(m);
                    }
                    if (board == null) continue;
                    bool mateTag = p.Themes.Any(t => t == "mate" || t.StartsWith("mateIn"));
                    if (mateTag && !board.IsCheckmate()) problems.Add(p.Id + " tagged mate but no mate");
                    if (p.HasTheme("oneMove") && p.Moves.Length != 2) problems.Add(p.Id + " oneMove with " + p.Moves.Length + " moves");
                }
                catch (Exception e) { problems.Add(p.Id + " " + e.Message); }
            }
            return problems.ToArray();
        }
    }

    // --- Stockfish over UCI ----------------------------------------------------------------
    public sealed class UciResult
    {
        public int Id;
        public bool Done;
        public string BestMove = "";
        public string[] Pv = new string[0];
        public int ScoreCp, MateIn, Depth;
        public bool IsMate, HasScore;
        public string Error = "";
        public UciResult Copy() { var c = (UciResult)MemberwiseClone(); c.Pv = (string[])Pv.Clone(); return c; }
        // The score in centipawns for the side to move; mates become huge numbers.
        public int Value { get { return IsMate ? (MateIn > 0 ? 100000 - MateIn : -100000 - MateIn) : ScoreCp; } }
    }

    public sealed class UciEngine
    {
        Process process;
        Thread reader;
        readonly object gate = new object();
        UciResult current = new UciResult();
        int nextId, ignoreBestMoves;
        DateTime started;
        int budgetMs;
        readonly List<string> log = new List<string>();
        public string Status = "starting";   // starting ready busy dead

        public static UciEngine Start(string exePath, int threads, int hashMb)
        {
            var engine = new UciEngine();
            var info = new ProcessStartInfo(exePath)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
                WorkingDirectory = Path.GetDirectoryName(exePath),
            };
            engine.process = Process.Start(info);
            ChessWin32.TieToThisProcess(engine.process);
            try { engine.process.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            engine.reader = new Thread(engine.ReadLoop) { IsBackground = true, Name = "stockfish-reader" };
            engine.reader.Start();
            engine.Send("uci");
            engine.Send("setoption name Threads value " + threads);
            engine.Send("setoption name Hash value " + hashMb);
            engine.Send("isready");
            return engine;
        }

        void Send(string line)
        {
            try { process.StandardInput.WriteLine(line); process.StandardInput.Flush(); }
            catch (Exception e) { lock (gate) { Status = "dead"; current.Error = e.Message; } }
        }

        void ReadLoop()
        {
            try
            {
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null)
                {
                    lock (gate)
                    {
                        if (log.Count < 400) log.Add(line);
                        if (line == "readyok" && Status == "starting") Status = "ready";
                        else if (line.StartsWith("info ") && current.Id > 0 && !current.Done) ParseInfo(line, current);
                        else if (line.StartsWith("bestmove"))
                        {
                            if (ignoreBestMoves > 0) { ignoreBestMoves--; continue; }
                            var parts = line.Split(' ');
                            current.BestMove = parts.Length > 1 ? parts[1] : "";
                            current.Done = true;
                            Status = "ready";
                        }
                    }
                }
            }
            catch { }
            lock (gate) { Status = "dead"; if (!current.Done) current.Error = "engine stopped"; }
        }

        public static void ParseInfo(string line, UciResult into)
        {
            var words = line.Split(' ');
            int depth = into.Depth;
            for (int i = 1; i < words.Length; i++)
            {
                if (words[i] == "depth" && i + 1 < words.Length) int.TryParse(words[i + 1], out depth);
                else if (words[i] == "score" && i + 2 < words.Length)
                {
                    int value;
                    if (!int.TryParse(words[i + 2], out value)) continue;
                    into.IsMate = words[i + 1] == "mate";
                    if (into.IsMate) into.MateIn = value; else into.ScoreCp = value;
                    into.HasScore = true;
                }
                else if (words[i] == "pv")
                {
                    into.Pv = words.Skip(i + 1).Where(w => w.Length >= 4).ToArray();
                    break;
                }
            }
            into.Depth = depth;
        }

        // Starts an analysis of the position after `moves`; searchMoves limits the
        // first move. Returns the request id that Poll reports on.
        public int Analyse(string fen, string[] moves, int movetimeMs, string[] searchMoves)
        {
            lock (gate)
            {
                if (Status == "dead") return 0;
                if (current.Id > 0 && !current.Done) { ignoreBestMoves++; }
                current = new UciResult { Id = ++nextId };
                started = DateTime.UtcNow;
                budgetMs = movetimeMs;
                Status = "busy";
            }
            if (ignoreBestMoves > 0) Send("stop");
            string position = "position fen " + fen + (moves != null && moves.Length > 0 ? " moves " + string.Join(" ", moves) : "");
            Send(position);
            Send("go movetime " + movetimeMs + (searchMoves != null && searchMoves.Length > 0 ? " searchmoves " + string.Join(" ", searchMoves) : ""));
            return nextId;
        }

        public UciResult Poll()
        {
            lock (gate)
            {
                if (!current.Done && current.Id > 0 && (DateTime.UtcNow - started).TotalMilliseconds > budgetMs + 4000)
                {
                    current.Error = "timeout";
                    current.Done = true;
                    Status = "dead";
                }
                return current.Copy();
            }
        }

        public string[] DrainLog() { lock (gate) { var lines = log.ToArray(); log.Clear(); return lines; } }

        public void Quit()
        {
            try
            {
                Send("quit");
                if (!process.WaitForExit(300)) process.Kill();
            }
            catch { }
            lock (gate) Status = "dead";
        }
    }

    // --- Downloads Stockfish once, checks it, unpacks it ----------------------------------------
    public sealed class EngineInstaller
    {
        public const string URL = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip";
        public const long SIZE = 81431614;
        public const string SHA256 = "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7";
        public const string VERSION = "sf_19";
        public string Status = "idle";       // idle downloading verifying extracting done failed
        public long BytesDone, BytesTotal = SIZE;
        public string Error = "", ExePath = "";
        Thread worker;

        // The installed engine, or null.
        public static string Find(string dir)
        {
            try
            {
                string exe = Path.Combine(dir, "stockfish.exe"), marker = Path.Combine(dir, "installed.txt");
                if (File.Exists(exe) && File.Exists(marker) && File.ReadAllText(marker).Contains(SHA256)) return exe;
            }
            catch { }
            return null;
        }

        public int Percent { get { return BytesTotal > 0 ? (int)(100 * BytesDone / BytesTotal) : 0; } }

        public void Begin(string dir)
        {
            if (worker != null && worker.IsAlive) return;
            Status = "downloading"; Error = "";
            worker = new Thread(() => Run(dir)) { IsBackground = true, Name = "stockfish-download" };
            worker.Start();
        }

        void Run(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string part = Path.Combine(dir, "download.part"), zip = Path.Combine(dir, "download.zip"), unpacked = Path.Combine(dir, "extract");
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                long have = File.Exists(part) ? new FileInfo(part).Length : 0;
                if (have > SIZE) { File.Delete(part); have = 0; }
                if (have < SIZE)
                {
                    var request = (HttpWebRequest)WebRequest.Create(URL);
                    request.AllowAutoRedirect = true;
                    request.UserAgent = "ClaudeChessPuzzles";
                    request.Timeout = 30000;
                    request.ReadWriteTimeout = 30000;
                    if (have > 0) request.AddRange(have);
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        bool resumed = response.StatusCode == HttpStatusCode.PartialContent;
                        if (!resumed) have = 0;
                        using (var input = response.GetResponseStream())
                        using (var output = new FileStream(part, resumed ? FileMode.Append : FileMode.Create, FileAccess.Write))
                        {
                            var buffer = new byte[81920];
                            int read;
                            BytesDone = have;
                            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                output.Write(buffer, 0, read);
                                BytesDone += read;
                                if (BytesDone > SIZE) throw new IOException("the download is larger than expected");
                            }
                        }
                    }
                }
                Status = "verifying";
                if (new FileInfo(part).Length != SIZE) throw new IOException("the download stopped early");
                string hash;
                using (var stream = File.OpenRead(part))
                using (var sha = System.Security.Cryptography.SHA256.Create())
                    hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (hash != SHA256) { File.Delete(part); throw new IOException("the download failed its checksum"); }
                Status = "extracting";
                if (File.Exists(zip)) File.Delete(zip);
                File.Move(part, zip);
                if (Directory.Exists(unpacked)) Directory.Delete(unpacked, true);
                System.IO.Compression.ZipFile.ExtractToDirectory(zip, unpacked);
                string found = Directory.GetFiles(unpacked, "stockfish*.exe", SearchOption.AllDirectories).FirstOrDefault();
                if (found == null) throw new IOException("no stockfish .exe in the download");
                string exe = Path.Combine(dir, "stockfish.exe");
                if (File.Exists(exe)) File.Delete(exe);
                File.Move(found, exe);
                File.WriteAllText(Path.Combine(dir, "installed.txt"), VERSION + " " + SHA256);
                try { File.Delete(zip); Directory.Delete(unpacked, true); } catch { }
                ExePath = exe;
                Status = "done";
            }
            catch (Exception e)
            {
                Error = e.Message;
                Status = "failed";
            }
        }
    }

    // --- Saves that can't be half-written ------------------------------------------------------
    public static class SafeFile
    {
        public static void WriteAtomic(string path, string text)
        {
            string temp = path + ".tmp", backup = path + ".bak";
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(temp, text, Encoding.ASCII);
            if (!File.Exists(path)) { File.Move(temp, path); return; }
            try { File.Replace(temp, path, backup, true); }
            catch
            {
                File.Copy(path, backup, true);
                File.Copy(temp, path, true);
                File.Delete(temp);
            }
        }

        public static string Read(string path)
        {
            try { return File.Exists(path) ? File.ReadAllText(path, Encoding.ASCII) : null; }
            catch { return null; }
        }
    }
}
