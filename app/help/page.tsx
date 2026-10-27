import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CalendarDays } from "lucide-react";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "使い方｜うちわカレンダー",
  description: "予定の登録、共有リンク、別端末への引き継ぎ、外部カレンダーでの購読をご案内します。",
};

const sections = [
  ["start", "はじめに"],
  ["events", "予定の登録・編集"],
  ["repeat", "毎週の繰り返し"],
  ["calendar", "カレンダーの操作"],
  ["devices", "PC・スマートフォンの操作"],
  ["links", "3種類のリンク"],
  ["refresh", "予定の更新"],
  ["questions", "困ったとき"],
] as const;

export default function HelpPage() {
  return <div className="app-shell">
    <header className="topbar">
      <Link href="/" className="brand"><span className="brand-mark"><CalendarDays size={17}/></span><span>うちわカレンダー</span></Link>
      <Link href="/" className={styles.back}><ArrowLeft size={15}/>トップへ</Link>
    </header>
    <main className={styles.page}>
      <div className={styles.intro}>
        <p className={styles.label}>うちわカレンダー</p>
        <h1>使い方</h1>
        <p>予定を登録して、家族や友だちと共有しましょう。<br/>初めての方は「はじめに」からお読みください。</p>
      </div>
      <div className={styles.layout}>
        <nav className={styles.contents} aria-label="使い方の目次">
          <h2>目次</h2>
          <ol>{sections.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>
        </nav>
        <div className={styles.sections}>
          <section id="start" className={styles.section} aria-labelledby="start-title">
            <h2 id="start-title">はじめに</h2>
            <ol className={styles.steps}>
              <li><strong>カレンダーを作る</strong><p>トップ画面で名前を入力し、「作成する」を押します。共有リンクを受け取った方は、そのリンクを開きます。</p></li>
              <li><strong>みんなに共有する</strong><p>画面上部の「共有リンク」でURLをコピーし、一緒に使う人へ送ります。リンクを開くと予定を閲覧できます。</p></li>
              <li><strong>名前を登録する</strong><p>「参加する」を押し、表示名を登録します。参加情報はこのブラウザーに保存されます。</p></li>
              <li><strong>予定を追加する</strong><p>日付を選び、「この日に予定を追加」から予定名と日付を入力して保存します。</p></li>
            </ol>
          </section>
          <section id="events" className={styles.section} aria-labelledby="events-title">
            <h2 id="events-title">予定の登録・編集</h2>
            <p>予定はすべて終日です。1日だけの予定は開始日と終了日を同じ日にします。複数日の予定は、開始日から終了日までの両端を含みます。</p>
            <p>日付を選ぶと、その日の予定が一覧に表示されます。自分の予定の鉛筆ボタンから編集し、「保存する」で反映します。削除する場合も同じ画面から操作します。</p>
          </section>
          <section id="repeat" className={styles.section} aria-labelledby="repeat-title">
            <h2 id="repeat-title">毎週の繰り返し</h2>
            <p>予定の入力画面で「毎週繰り返す」にチェックを入れると、開始日と同じ曜日に繰り返します。1日分の予定が対象です。</p>
            <ul><li>「終了日」：開始日から1年以内の日付を指定します。</li><li>「回数」：最初の予定を含む2〜53回を指定します。</li></ul>
            <p className={styles.note}>編集・削除は、過去の分を含む繰り返し予定すべてに反映されます。</p>
          </section>
          <section id="calendar" className={styles.section} aria-labelledby="calendar-title">
            <h2 id="calendar-title">カレンダーの操作</h2>
            <ul>
              <li>日付を選ぶと、その日の予定が表示されます。「ほか○件」を押すと、隠れている予定も一覧で確認できます。</li>
              <li>月の横にある左右のボタンで月を移動し、「今日」で今日の月と日付に戻ります。</li>
              <li>メンバーの名前を押すと、その人の予定の表示・非表示が切り替わります。もう一度押すと再表示します。</li>
              <li>自分の色は「共有・設定」の「あなたの色」で変更できます。</li>
            </ul>
          </section>
          <section id="devices" className={styles.section} aria-labelledby="devices-title">
            <h2 id="devices-title">PC・スマートフォンの操作</h2>
            <h3>PC</h3>
            <ul>
              <li>日付をダブルクリックすると、その日の予定を追加できます。</li>
              <li>開始日から終了日までドラッグすると、期間を指定して予定を追加できます。</li>
              <li><kbd>&lt;</kbd> または <kbd>,</kbd> で前月、<kbd>&gt;</kbd> または <kbd>.</kbd> で翌月へ移動します。入力中・日本語変換中・ダイアログ表示中は無効です。</li>
            </ul>
            <h3>スマートフォン</h3>
            <ul><li>カレンダーを左へスワイプすると翌月、右へスワイプすると前月へ移動します。</li><li>開始日を長押しし、終了日まで指を動かして離すと、期間を指定して予定を追加できます。</li></ul>
          </section>
          <section id="links" className={styles.section} aria-labelledby="links-title">
            <h2 id="links-title">3種類のリンク</h2>
            <p>画面下部の「共有・設定」からコピーできます。</p>
            <dl className={styles.links}>
              <div><dt>共有リンク</dt><dd>みんなでカレンダーを閲覧・参加するためのURLです。一緒に使う人へ送ってください。</dd></div>
              <div><dt>あなたの個人リンク</dt><dd>別端末や別ブラウザーでも、自分として使うためのURLです。参加後にコピーして保管し、使いたい端末で開いてください。同じ名前で参加する操作は、別のメンバーとして登録されます。</dd></div>
              <div><dt>購読URL</dt><dd>予定を外部のカレンダーアプリで見るためのURLです。コピーしたURLを、そのアプリのカレンダー購読機能に登録します。予定と登録者名が購読先に渡ります。編集はうちわカレンダーで行います。</dd></div>
            </dl>
            <p className={styles.note}>個人リンクを渡すと、相手も自分として予定を操作できます。ご自身だけで保管してください。</p>
            <h3>リンクを再発行するとき</h3>
            <p>共有リンクを再発行すると、古い共有リンクと購読URLが無効になります。新しいリンクを配り、購読先にも登録し直してください。参加済みの人の参加情報と個人リンクは引き続き使えます。</p>
            <p>個人リンクを再発行すると、古い個人リンクと、ほかの端末の参加情報が無効になります。新しい個人リンクを保管し、ほかの端末でも開き直してください。予定・名前・色は引き継がれます。</p>
          </section>
          <section id="refresh" className={styles.section} aria-labelledby="refresh-title">
            <h2 id="refresh-title">予定の更新</h2>
            <p>カレンダーを開いたときと、自分が予定を保存・削除した直後に最新情報を取得します。他の人の変更は、PCの画面上部にある更新ボタンか、ページの再読み込みで反映してください。</p>
            <p>外部カレンダーの更新タイミングは、購読先のアプリによって異なります。うちわカレンダーでの更新が届くまで、時間がかかる場合があります。</p>
          </section>
          <section id="questions" className={styles.section} aria-labelledby="questions-title">
            <h2 id="questions-title">困ったとき</h2>
            <h3>自分の予定を編集できません</h3>
            <p>登録時と異なる端末・ブラウザーを使っている場合は、保管した個人リンクから開き直してください。「共有・設定」に表示される名前で、現在の参加者を確認できます。</p>
            <h3>同じ名前で参加し直してしまいました</h3>
            <p>同じ名前でも、参加し直すと別のメンバーになります。元の個人リンクを開き、参加者の切り替えを確認してください。</p>
            <h3>個人リンクをなくしました</h3>
            <p>自分として使えるブラウザーが残っていれば、「共有・設定」からコピーできます。個人リンクとブラウザーの参加情報を両方失った場合、名前だけでは復元できません。</p>
            <h3>共有リンクを開けません</h3>
            <p>リンクが再発行された可能性があります。共有した人に最新のリンクを確認してください。</p>
            <h3>「別の端末で更新されました」と表示されます</h3>
            <p>ページを再読み込みし、最新の予定を確認してから編集し直してください。入力中の内容は、再読み込みの前に控えてください。</p>
          </section>
          <footer className={styles.end}><a href="#start">はじめに戻る</a><Link href="/">トップへ</Link></footer>
        </div>
      </div>
    </main>
  </div>;
}
