import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type LayoutProps = { children: React.ReactNode };

const navigation = [
  { href: '/', label: 'Overview', icon: '⌂' },
  { href: '/calendar', label: 'Content calendar', icon: '▦' },
  { href: '/content/new', label: 'Create content', icon: '+' },
  { href: '/queues', label: 'Queue monitor', icon: '◌' },
  { href: '/niches', label: 'Niche profiles', icon: '✦' },
  { href: '/accounts', label: 'Connected accounts', icon: '◎' },
  { href: '/audit', label: 'Audit history', icon: '≡' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Layout({ children }: LayoutProps) {
  const router = useRouter();
  const [publishingDisabled, setPublishingDisabled] = useState(true);
  useEffect(() => {
    let active = true;
    api<any>('/api/settings')
      .then((s) => { if (active) setPublishingDisabled(!!s.publishingDisabled); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">VF</span><div><strong>ViralForge</strong><small>Creator operations</small></div></div>
        <nav className="nav-list">
          {navigation.map((item) => <Link key={item.href} href={item.href} className={`nav-item ${router.pathname === item.href || (item.href !== '/' && router.pathname.startsWith(item.href)) ? 'active' : ''}`}><span>{item.icon}</span>{item.label}</Link>)}
        </nav>
        <div className="sidebar-note"><span className="live-dot" /> Local safe mode<br /><small>{publishingDisabled ? 'Publishing is protected' : 'Publishing is enabled'}</small></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div><span className="eyebrow">VIRALFORGE STUDIO</span><h1>{navigation.find((item) => item.href === router.pathname || (item.href !== '/' && router.pathname.startsWith(item.href)))?.label || 'Overview'}</h1></div><div className="topbar-actions"><span className={publishingDisabled ? 'safe-badge' : 'safe-badge'} style={publishingDisabled ? {} : { background: '#e4f0e9', color: '#2d6a4f' }}>{publishingDisabled ? '● Publishing disabled' : '● Publishing enabled'}</span><Link className="button primary" href="/content/new">＋ New content</Link></div></header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
