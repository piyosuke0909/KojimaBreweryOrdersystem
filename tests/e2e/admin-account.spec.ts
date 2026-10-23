import {expect,test,type Page,type Route} from '@playwright/test';
const oldPassword='browser-current-password',newPassword='browser-new-password';
async function setup(page:Page,{demo=false,reject=false}:{demo?:boolean;reject?:boolean}={}){
  const state={account:{id:demo?'demo-admin':'account-admin',login_id:demo?'demo-admin':'kojima-admin',name:'管理者',role:'staff',can_change_credentials:!demo},saves:[] as any[],reject};
  const send=(route:Route,data:unknown,status=200)=>route.fulfill({status,json:status<400?{data}:{error:data}});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/me')return send(route,{actor:{...state.account,type:'admin'}});
    if(path==='/api/config')return send(route,{environment:'development',demo_enabled:false});
    if(path==='/api/admin/notifications')return send(route,{items:[],total_unread:0,counts:{orders:0,companies:0}});
    if(path==='/api/admin/account'){
      if(route.request().method()==='GET')return send(route,state.account);
      const input=route.request().postDataJSON();state.saves.push(input);
      if(state.reject)return send(route,{code:'CURRENT_PASSWORD_INCORRECT',message:'現在のパスワードが違います。'},400);
      state.account.login_id=input.login_id;return send(route,{...state.account,changed:true});
    }
    return send(route,{});
  });
  await page.goto('/admin/settings?tab=account');
  await expect(page.getByRole('tab',{name:'ログイン設定',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('textbox',{name:'ログインユーザー名',exact:true})).toHaveValue(state.account.login_id);
  return state;
}
const username=(page:Page)=>page.getByRole('textbox',{name:'ログインユーザー名',exact:true});
const current=(page:Page)=>page.getByLabel('現在のパスワード',{exact:true});
const password=(page:Page)=>page.getByLabel('新しいパスワード',{exact:true});
const confirmation=(page:Page)=>page.getByLabel('新しいパスワード（確認）',{exact:true});
const dialog=(page:Page)=>page.getByRole('dialog',{name:'ログイン設定を変更しますか？',exact:true});

test('現在のユーザー名だけを表示し、パスワードは空欄で初期表示では保存しない',async({page})=>{
  const state=await setup(page);await expect(current(page)).toHaveValue('');await expect(password(page)).toHaveValue('');await expect(confirmation(page)).toHaveValue('');
  await expect(current(page)).toHaveAttribute('type','password');await expect(password(page)).toHaveAttribute('type','password');
  await expect(page.getByRole('button',{name:'変更内容を確認',exact:true})).toBeDisabled();expect(state.saves).toHaveLength(0);
});
test('ユーザー名だけの変更も現在のパスワードを確認し、明示確認後だけ一度保存する',async({page})=>{
  const state=await setup(page);await username(page).fill('revised.kojima');await current(page).fill(oldPassword);
  await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await expect(dialog(page)).toBeVisible();expect(state.saves).toHaveLength(0);
  await dialog(page).getByRole('button',{name:'戻る',exact:true}).click();expect(state.saves).toHaveLength(0);
  await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await dialog(page).getByRole('button',{name:'確認して実行',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('ログイン設定を変更しました');
  expect(state.saves).toEqual([{login_id:'revised.kojima',current_password:oldPassword}]);await expect(username(page)).toHaveValue('revised.kojima');await expect(current(page)).toHaveValue('');
});
test('確認用パスワードの不一致を保存前に知らせ、入力を保持する',async({page})=>{
  const state=await setup(page);await current(page).fill(oldPassword);await password(page).fill(newPassword);await confirmation(page).fill('different-new-password');
  await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await expect(page.getByRole('alert')).toContainText('確認が一致しません');await expect(dialog(page)).toHaveCount(0);
  await expect(password(page)).toHaveValue(newPassword);expect(state.saves).toHaveLength(0);
});
test('パスワード変更後は入力を消し、秘密の値をブラウザーの永続ストレージに保存しない',async({page})=>{
  const state=await setup(page);await current(page).fill(oldPassword);await password(page).fill(newPassword);await confirmation(page).fill(newPassword);
  await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await expect(dialog(page)).toContainText('パスワードも変更します');
  await dialog(page).getByRole('button',{name:'確認して実行',exact:true}).click();await expect(page.getByRole('status')).toContainText('ログイン設定を変更しました');
  expect(state.saves).toEqual([{login_id:'kojima-admin',current_password:oldPassword,new_password:newPassword,confirm_password:newPassword}]);
  for(const input of [current(page),password(page),confirmation(page)])await expect(input).toHaveValue('');
  const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(oldPassword);expect(storage).not.toContain(newPassword);
});
test('現在のパスワードが違う場合は設定と入力を保持し、修正して再試行できる',async({page})=>{
  const state=await setup(page,{reject:true});await username(page).fill('new-admin');await current(page).fill('wrong-password');
  await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await dialog(page).getByRole('button',{name:'確認して実行',exact:true}).click();await expect(page.getByRole('alert')).toContainText('現在のパスワードが違います');
  await expect(username(page)).toHaveValue('new-admin');expect(state.account.login_id).toBe('kojima-admin');
  state.reject=false;await current(page).fill(oldPassword);await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();await dialog(page).getByRole('button',{name:'確認して実行',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('ログイン設定を変更しました');expect(state.saves).toHaveLength(2);
});
test('自動生成パスワードのデモ管理者では変更方法を案内し、変更フォームを停止する',async({page})=>{
  const state=await setup(page,{demo:true});await expect(page.getByText('デモ管理者のパスワードは自動生成されています。',{exact:false})).toBeVisible();
  await expect(username(page)).toBeDisabled();await expect(current(page)).toBeDisabled();await expect(page.getByRole('button',{name:'変更内容を確認',exact:true})).toBeDisabled();expect(state.saves).toHaveLength(0);
});
for(const width of [390,768,1366])test(`${width}pxでログイン設定と確認ダイアログが画面内に収まる`,async({page})=>{
  await page.setViewportSize({width,height:900});await setup(page);await username(page).fill('new-admin');await current(page).fill(oldPassword);await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();
  await expect(dialog(page)).toBeVisible();const overflow=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth);expect(overflow).toBeLessThanOrEqual(1);
});
