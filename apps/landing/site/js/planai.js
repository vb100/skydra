document.querySelectorAll('[data-set]').forEach(function(b){b.addEventListener('click',function(){
var m=b.getAttribute('data-set');var a=document.querySelector('[data-billing="annual"]');var mo=document.querySelector('[data-billing="monthly"]');
if(m==='annual'){a.hidden=false;mo.hidden=true;}else{a.hidden=true;mo.hidden=false;}
});});
