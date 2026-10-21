import { useEffect, useId, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X, LoaderCircle, Inbox, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { labels } from './api';

/** Keep the real link/button in the row for assistive technology and new-tab actions. */
export function navigableRowProps(onActivate:()=>void,label:string) {
 const interactive='a,button,input,select,textarea,label,[role="button"],[role="link"],[contenteditable="true"],[data-row-ignore]';
 return {
  tabIndex:0,
  'aria-label':`${label}。Enterキーで開きます`,
  'data-row-navigation':true,
  className:'admin-clickable-row',
  onClick:(event:MouseEvent<HTMLElement>)=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
   const target=event.target as HTMLElement;
   if(target.closest(interactive)||window.getSelection()?.toString())return;
   onActivate();
  },
  onKeyDown:(event:KeyboardEvent<HTMLElement>)=>{
   if(event.target!==event.currentTarget||event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey)return;
   if(event.key==='Enter'||event.key===' '){event.preventDefault();onActivate()}
  }
 };
}
export function useRowNavigation(){const navigate=useNavigate();return (to:string,label:string)=>navigableRowProps(()=>navigate(to),label)}

/** Inline help can live inside a label; the explanation is portalled to avoid card clipping. */
export function FieldHelp({label,help,hideLabel=false}:{label:string;help:ReactNode;hideLabel?:boolean}) {
 const [open,setOpen]=useState(false),[position,setPosition]=useState({top:0,left:0}),button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),id=useId();
 useEffect(()=>{
  if(!open)return;
  const place=()=>{const r=button.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(12,Math.min(r.left,window.innerWidth-316)),top:Math.max(12,Math.min(r.bottom+9,window.innerHeight-190))})};place();
  const outside=(e:globalThis.MouseEvent)=>{if(!button.current?.contains(e.target as Node)&&!panel.current?.contains(e.target as Node))setOpen(false)};
  const escape=(e:globalThis.KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();setOpen(false);button.current?.focus()}};
  document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape,true);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape,true);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)};
 },[open]);
 return <span className="admin-field-help">{!hideLabel&&<span>{label}</span>}<button ref={button} type="button" className="admin-help-button" aria-label={`${label}の説明`} aria-expanded={open} aria-controls={open?id:undefined} onClick={e=>{e.preventDefault();e.stopPropagation();setOpen(!open)}}>?</button>{open&&createPortal(<div ref={panel} className="admin-help-popover" id={id} role="note" aria-label={`${label}の説明`} style={position}><strong>{label}</strong><button type="button" className="admin-help-close" aria-label="説明を閉じる" onClick={()=>{setOpen(false);button.current?.focus()}}><X size={15}/></button><div>{help}</div></div>,document.body)}</span>
}
export function Badge({value}:{value:string}) { return <span className={`admin-badge ${value}`}>{labels[value] || value}</span> }
export function Loading() { return <div className="admin-state" role="status"><LoaderCircle className="admin-spin" size={26}/><span>読み込んでいます…</span></div> }
export function Empty({text='該当するデータがありません'}:{text?:string}) { return <div className="admin-state"><Inbox size={34}/><strong>{text}</strong><span>検索条件を変更するか、新しく登録してください。</span></div> }
export function ErrorBox({error}:{error:string}) { return error ? <div className="admin-alert error" role="alert"><AlertCircle size={18}/>{error}</div> : null }
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
 const ref=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const focusable=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]).filter(e=>e.offsetParent!==null);const h=(e:globalThis.KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close.current()}if(e.key==='Tab'){const nodes=focusable(),first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener('keydown',h);const old=document.body.style.overflow;document.body.style.overflow='hidden';focusable()[0]?.focus();return()=>{document.removeEventListener('keydown',h);document.body.style.overflow=old;previous?.focus()} },[]);
 return <div className="admin-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section ref={ref} className={`admin-modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label={title}><div className="admin-modal-head"><h2>{title}</h2><button className="admin-icon-btn" onClick={onClose} aria-label="閉じる"><X size={22}/></button></div>{children}</section></div>
}
export function ConfirmDialog({open,title,children,onConfirm,onClose,busy=false,confirmDisabled=false}:{open:boolean;title:string;children:ReactNode;onConfirm:()=>void;onClose:()=>void;busy?:boolean;confirmDisabled?:boolean}) { return open ? <Modal title={title} onClose={onClose}><div className="admin-modal-body">{children}</div><div className="admin-modal-foot"><button className="admin-btn secondary" onClick={onClose} disabled={busy}>戻る</button><button className="admin-btn primary" onClick={onConfirm} disabled={busy||confirmDisabled}>{busy?'処理中…':'確認して実行'}</button></div></Modal> : null }
export function Pagination({page,total,pageSize=20,onChange}:{page:number;total:number;pageSize?:number;onChange:(page:number)=>void}) { const max=Math.max(1,Math.ceil(total/pageSize)); return <div className="admin-pagination"><span>{total.toLocaleString()}件中 {total?((page-1)*pageSize+1):0}〜{Math.min(page*pageSize,total)}件</span><div><button aria-label="前のページ" disabled={page<=1} onClick={()=>onChange(page-1)}><ChevronLeft size={18}/></button><span>{page} / {max}</span><button aria-label="次のページ" disabled={page>=max} onClick={()=>onChange(page+1)}><ChevronRight size={18}/></button></div></div> }
